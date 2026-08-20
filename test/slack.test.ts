import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { stripMention, verifySlackSignature } from "../src/slack.ts";

const SECRET = "test-signing-secret";

function sign(body: string, timestamp: number): string {
  return "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex");
}

test("accepts a correctly signed request", () => {
  const body = '{"type":"event_callback"}';
  const ts = 1_800_000_000;
  assert.equal(verifySlackSignature(body, String(ts), sign(body, ts), SECRET, ts), true);
});

test("rejects a tampered body", () => {
  const ts = 1_800_000_000;
  const signature = sign('{"type":"event_callback"}', ts);
  assert.equal(verifySlackSignature('{"type":"evil"}', String(ts), signature, SECRET, ts), false);
});

test("rejects a replay outside the five-minute window", () => {
  const body = "{}";
  const ts = 1_800_000_000;
  assert.equal(verifySlackSignature(body, String(ts), sign(body, ts), SECRET, ts + 301), false);
});

test("rejects a missing signature without throwing", () => {
  assert.equal(verifySlackSignature("{}", "1800000000", undefined, SECRET, 1_800_000_000), false);
});

test("rejects a signature of the wrong length without throwing", () => {
  const ts = 1_800_000_000;
  assert.equal(verifySlackSignature("{}", String(ts), "v0=short", SECRET, ts), false);
});

test("strips the mention and leaves the instruction", () => {
  assert.equal(stripMention("<@U123ABC> save this to the FAQ"), "save this to the FAQ");
  assert.equal(stripMention("hey <@U123ABC>   what is a courier?"), "hey what is a courier?");
});
