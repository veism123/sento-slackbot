import crypto from "node:crypto";
import { config } from "./config.ts";
import { log } from "./log.ts";

/** Slack rejects its own signature outside this window; so do we. */
const MAX_SKEW_SECONDS = 300;

/**
 * Verify a Slack request signature over the RAW body. Parse the body only
 * after this passes: an unverified payload is an internet stranger's JSON.
 */
export function verifySlackSignature(
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  signingSecret: string = config.slack.signingSecret,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (timestampHeader === undefined || signatureHeader === undefined) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > MAX_SKEW_SECONDS) return false;

  const expected =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(`v0:${timestampHeader}:${rawBody}`)
      .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  // timingSafeEqual throws on a length mismatch, so guard before comparing.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function call(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.slack.botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as Record<string, unknown>;
  if (body.ok !== true) {
    throw new Error(`Slack ${method} failed: ${String(body.error ?? "unknown_error")}`);
  }
  return body;
}

export async function postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
  await call("chat.postMessage", { channel, text, thread_ts: threadTs, unfurl_links: false });
}

/** Best-effort: a missing reaction is never worth failing a save over. */
export async function addReaction(channel: string, timestamp: string, name: string): Promise<void> {
  try {
    await call("reactions.add", { channel, timestamp, name });
  } catch (err) {
    log.warn(`Could not add :${name}:`, err);
  }
}

export type ThreadMessage = { user: string; text: string; ts: string };

/**
 * The messages that give the mention its meaning. Tagging the bot in a thread
 * means "file THIS thread", so the parent and its replies are the material —
 * not the two words next to the mention.
 */
export async function fetchThread(channel: string, threadTs: string, limit = 30): Promise<ThreadMessage[]> {
  const body = await call("conversations.replies", { channel, ts: threadTs, limit });
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const record = raw as Record<string, unknown>;
    if (typeof record.text !== "string" || typeof record.ts !== "string") return [];
    return [{ user: typeof record.user === "string" ? record.user : "unknown", text: record.text, ts: record.ts }];
  });
}

/**
 * When the bot is tagged outside a thread, "summarize this" means the recent
 * conversation in the channel, not the single message carrying the mention.
 */
export async function fetchChannelHistory(channel: string, latestTs: string, limit = 50): Promise<ThreadMessage[]> {
  const body = await call("conversations.history", { channel, latest: latestTs, limit, inclusive: false });
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parsed = messages.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const record = raw as Record<string, unknown>;
    if (typeof record.text !== "string" || typeof record.ts !== "string") return [];
    if (record.subtype !== undefined) return []; // joins, leaves, channel chatter
    return [{ user: typeof record.user === "string" ? record.user : "unknown", text: record.text, ts: record.ts }];
  });
  // Slack returns newest first; a conversation reads oldest first.
  return parsed.reverse();
}

/** A link back to the source, so a written summary stays traceable to it. */
export async function getPermalink(channel: string, ts: string): Promise<string | undefined> {
  try {
    const body = await call("chat.getPermalink", { channel, message_ts: ts });
    return typeof body.permalink === "string" ? body.permalink : undefined;
  } catch (err) {
    log.warn("Could not get a permalink", err);
    return undefined;
  }
}

let botUserId: string | undefined;

/**
 * The bot's own user id, from auth.test, cached for the process lifetime.
 * Needed to recognize our own replies in a thread and our own mention in a
 * message. Undefined only if auth.test fails, in which case follow-up
 * detection quietly degrades to mentions-only.
 */
export async function getBotUserId(): Promise<string | undefined> {
  if (botUserId !== undefined) return botUserId;
  try {
    const body = await call("auth.test", {});
    if (typeof body.user_id === "string") botUserId = body.user_id;
  } catch (err) {
    log.warn("auth.test failed; follow-up detection is off until it succeeds.", err);
  }
  return botUserId;
}

const displayNames = new Map<string, string>();

/** A Slack handle for attribution. Cached: the same few people all day. */
export async function getUserHandle(userId: string): Promise<string> {
  const hit = displayNames.get(userId);
  if (hit !== undefined) return hit;

  try {
    const body = await call("users.info", { user: userId });
    const user = body.user as Record<string, unknown> | undefined;
    const profile = user?.profile as Record<string, unknown> | undefined;
    const name =
      (typeof profile?.display_name === "string" && profile.display_name !== "" ? profile.display_name : undefined) ??
      (typeof user?.name === "string" ? user.name : undefined) ??
      userId;
    displayNames.set(userId, name);
    return name;
  } catch (err) {
    log.warn(`Could not resolve ${userId}`, err);
    return userId;
  }
}

/** Strip the leading <@BOTID> so the instruction reads as a sentence. */
export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, " ").replace(/\s+/g, " ").trim();
}
