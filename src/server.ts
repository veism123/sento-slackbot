import http from "node:http";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { verifySlackSignature } from "./slack.ts";
import { dispatch } from "./handle.ts";
import type { SlackEvent } from "./handle.ts";

/**
 * Slack retries any event it does not get a 200 for within three seconds, and
 * a Sento round trip takes far longer than that. So this route does nothing
 * but verify, acknowledge, and hand off. All the work happens after the
 * response has already gone out.
 */

const MAX_BODY_BYTES = 1_000_000;
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

    const event = payload.event as SlackEvent | undefined;
    if (event === undefined || event.type !== "app_mention") return;
    if (event.bot_id !== undefined) return; // never answer ourselves

    const eventId =
      typeof payload.event_id === "string" ? payload.event_id : `${String(event.channel)}:${String(event.ts)}`;
    dispatch(event, eventId);
  })();
});

export function startHttpServer(): void {
  server.listen(config.port, () => {
    log.info(`HTTP mode: listening on :${config.port}/slack/events`);
  });
}
