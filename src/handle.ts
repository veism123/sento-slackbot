import { log } from "./log.ts";
import { handleMention } from "./agent.ts";
import {
  addReaction,
  fetchChannelHistory,
  fetchThread,
  getBotUserId,
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
  subtype?: unknown;
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
 * Threads the bot has replied in, so a follow-up there needs no new tag. A
 * cache, not the truth: on a miss we look in the thread itself for one of our
 * replies, so a restart forgets nothing that matters.
 */
const THREAD_TTL_MS = 24 * 60 * 60 * 1000;

const ourThreads = new Map<string, number>();

export function rememberThread(channel: string, threadTs: string): void {
  const now = Date.now();
  for (const [key, at] of ourThreads) {
    if (now - at > THREAD_TTL_MS) ourThreads.delete(key);
  }
  ourThreads.set(`${channel}:${threadTs}`, now);
}

/**
 * A plain message counts as a follow-up only when all of these hold: it is in
 * a thread, it is a real user message (no subtype, not a bot), it does not
 * itself mention us (the app_mention event owns that one), and the thread is
 * one the bot has replied in. Everything else in the channel stays ignored —
 * starting a conversation still takes a tag.
 */
async function qualifiesAsFollowUp(event: Record<string, unknown>): Promise<boolean> {
  if (typeof event.thread_ts !== "string") return false;
  if (event.subtype !== undefined) return false;
  if (event.bot_id !== undefined) return false;
  if (typeof event.user !== "string") return false;

  const botId = await getBotUserId();
  if (botId === undefined) return false;
  if (event.user === botId) return false;
  if (String(event.text ?? "").includes(`<@${botId}>`)) return false;

  const channel = String(event.channel);
  const key = `${channel}:${event.thread_ts}`;
  if (ourThreads.has(key)) {
    ourThreads.set(key, Date.now());
    return true;
  }

  // Cache miss (a restart, or an old thread): the thread itself is the record.
  try {
    const thread = await fetchThread(channel, event.thread_ts);
    if (thread.some((message) => message.user === botId)) {
      rememberThread(channel, event.thread_ts);
      return true;
    }
  } catch (err) {
    log.warn("Could not check a thread for our own replies; ignoring the message.", err);
  }
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
async function buildPrompt(event: Record<string, unknown>, followUp: boolean): Promise<string> {
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
    followUp
      ? `From: @${askedBy}, replying in a thread you are already part of (no new tag needed)`
      : `Tagged by: @${askedBy}`,
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

async function work(event: Record<string, unknown>, followUp = false): Promise<void> {
  const channel = String(event.channel);
  const eventTs = String(event.ts);
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : eventTs;

  await addReaction(channel, eventTs, "eyes");

  try {
    const prompt = await buildPrompt(event, followUp);
    const result = await handleMention(prompt);

    log.info(`Handled a ${followUp ? "follow-up" : "mention"} in ${channel}`, { tools: result.toolCalls });
    await postMessage(channel, result.reply, threadTs);
    rememberThread(channel, threadTs);

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
 * Hand an event off to be worked on. Returns immediately: every transport has
 * an acknowledgement deadline far shorter than a Sento round trip, so the
 * work always outlives the acknowledgement.
 *
 * Mentions are always worked. A plain message is worked only when it
 * qualifies as a follow-up in a thread the bot has replied in; everything
 * else is dropped silently, because most channel traffic is not for us.
 */
export function dispatch(event: SlackEvent, eventId: string): void {
  if (alreadyHandled(eventId)) {
    log.info(`Ignoring a Slack retry of ${eventId}.`);
    return;
  }

  const record = event as Record<string, unknown>;
  if (event.type === "message") {
    void (async () => {
      if (await qualifiesAsFollowUp(record)) await work(record, true);
    })();
    return;
  }
  void work(record);
}
