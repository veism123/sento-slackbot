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
} from "./slack.ts";
import type { ThreadMessage } from "./slack.ts";

/**
 * What happens to a mention, independent of how it reached us. Both transports
 * — the HTTP events endpoint and Socket Mode — funnel into `dispatch`.
 */

export type SlackEvent = {
  type?: string;
  channel?: unknown;
  ts?: unknown;
  user?: unknown;
  text?: unknown;
  thread_ts?: unknown;
  bot_id?: unknown;
};

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


/**
 * Hand a mention off to be worked on. Returns immediately: every transport has
 * an acknowledgement deadline far shorter than a Sento round trip, so the
 * work always outlives the acknowledgement.
 */
export function dispatch(event: SlackEvent, eventId: string): void {
  if (alreadyHandled(eventId)) {
    log.info(`Ignoring a Slack retry of ${eventId}.`);
    return;
  }
  void work(event as Record<string, unknown>);
}
