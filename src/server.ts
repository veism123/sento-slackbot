import http from "node:http";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { handleMention } from "./agent.ts";
import {
  addReaction,
  fetchChannelHistory,
  fetchThread,
  getPermalink,
  getUserHandle,
  postMessage,
  stripMention,
  verifySlackSignature,
} from "./slack.ts";
import type { ThreadMessage } from "./slack.ts";

/**
 * Slack retries any event it does not get a 200 for within three seconds, and
 * a Midland round trip takes far longer than that. So this route does nothing
 * but verify, acknowledge, and hand off. All the work happens after the
 * response has already gone out.
 */

const MAX_BODY_BYTES = 1_000_000;
/** Slack's own retry window is short; an hour of ids is plenty and bounded. */
const SEEN_TTL_MS = 60 * 60 * 1000;

const seenEvents = new Map<string, number>();

function alreadyHandled(eventId: string): boolean {
  const now = Date.now();
  for (const [id, at] of seenEvents) {
    if (now - at > SEEN_TTL_MS) seenEvents.delete(id);
  }
  if (seenEvents.has(eventId)) return true;
  seenEvents.set(eventId, now);
  return false;
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Everything the mention means: the conversation it happened in, who said what,
 * and the instruction next to the mention itself.
 *
 * Which conversation depends on where the mention was. In a thread, the thread
 * is the material. Outside one, "summarize this" means the recent channel
 * conversation, not the single message carrying the mention.
 */
async function buildPrompt(event: Record<string, unknown>): Promise<string> {
  const channel = String(event.channel);
  const eventTs = String(event.ts);
  const inThread = typeof event.thread_ts === "string";
  const threadTs = inThread ? String(event.thread_ts) : eventTs;
  const askedBy = await getUserHandle(String(event.user));
  const instruction = stripMention(String(event.text ?? ""));

  const [context, permalink] = await Promise.all([
    (inThread
      ? fetchThread(channel, threadTs)
      : fetchChannelHistory(channel, eventTs)
    ).catch((err): ThreadMessage[] => {
      log.warn("Could not read the conversation; going on the mention alone.", err);
      return [];
    }),
    getPermalink(channel, eventTs),
  ]);

  const lines: string[] = [
    `Slack channel: ${channel}`,
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    `Tagged by: @${askedBy}`,
    `Link back to this moment in Slack: ${permalink ?? "(unavailable)"}`,
    "",
    `What they said to you: ${instruction === "" ? "(nothing beyond the mention)" : instruction}`,
  ];

  const material = context.filter((message) => message.ts !== eventTs);
  if (material.length > 0) {
    const named = await Promise.all(
      material.map(async (message) => {
        const when = new Date(Number(message.ts) * 1000).toISOString().replace("T", " ").slice(0, 16);
        return `[${when}] @${await getUserHandle(message.user)}: ${message.text}`;
      }),
    );
    lines.push(
      "",
      inThread
        ? "The thread they tagged you in, oldest first. This is the material:"
        : "The recent conversation in this channel, oldest first. This is the material:",
      "",
      ...named,
    );
  } else {
    lines.push("", "There is no surrounding conversation. The mention itself is all you have.");
  }

  return lines.join("\n");
}

async function work(event: Record<string, unknown>): Promise<void> {
  const channel = String(event.channel);
  const eventTs = String(event.ts);
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : eventTs;

  await addReaction(channel, eventTs, "eyes");

  try {
    const prompt = await buildPrompt(event);
    const result = await handleMention(prompt);

    log.info(`Handled a mention in ${channel}`, { tools: result.toolCalls });
    await postMessage(channel, result.reply, threadTs);

    const wrote = result.toolCalls.some((name) => name.startsWith("write_"));
    await addReaction(channel, eventTs, wrote ? "white_check_mark" : "eyes");
  } catch (err) {
    log.error("Handling the mention failed", err);
    const detail = err instanceof Error ? err.message : String(err);
    await postMessage(channel, `That did not work: ${detail}`, threadTs).catch((postErr) => {
      log.error("Could not even report the failure to Slack", postErr);
    });
  }
}

const server = http.createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }

    if (request.method !== "POST" || request.url !== "/slack/events") {
      response.writeHead(404).end();
      return;
    }

    let raw: string;
    try {
      raw = await readBody(request);
    } catch {
      response.writeHead(413).end();
      return;
    }

    const verified = verifySlackSignature(
      raw,
      request.headers["x-slack-request-timestamp"] as string | undefined,
      request.headers["x-slack-signature"] as string | undefined,
    );
    if (!verified) {
      log.warn("Rejected a request with a bad or missing Slack signature.");
      response.writeHead(401).end();
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      response.writeHead(400).end();
      return;
    }

    // The one-time handshake when you point Slack at this URL.
    if (payload.type === "url_verification") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(String(payload.challenge ?? ""));
      return;
    }

    // Acknowledge first. Slack's three-second budget is not negotiable.
    response.writeHead(200).end();

    if (payload.type !== "event_callback") return;

    const event = payload.event as Record<string, unknown> | undefined;
    if (event === undefined || event.type !== "app_mention") return;
    if (event.bot_id !== undefined) return; // never answer ourselves

    const eventId = typeof payload.event_id === "string" ? payload.event_id : `${String(event.channel)}:${String(event.ts)}`;
    if (alreadyHandled(eventId)) {
      log.info(`Ignoring a Slack retry of ${eventId}.`);
      return;
    }

    void work(event);
  })();
});

server.listen(config.port, () => {
  log.info(`Listening on :${config.port}`);
  log.info(`Midland: ${config.midland.baseUrl}`);
  log.info(`Model: ${config.anthropic.model}`);
  log.info(config.dryRun ? "DRY RUN: reads only, nothing will be written." : "LIVE: writes are enabled.");
});
