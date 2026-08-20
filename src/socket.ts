import { config } from "./config.ts";
import { log } from "./log.ts";
import type { SlackEvent } from "./handle.ts";

/**
 * Socket Mode: the bot opens an outbound WebSocket to Slack instead of Slack
 * calling in. No public URL, no tunnel, no request-URL round trip, and no
 * signature to verify, because the connection itself is authenticated.
 *
 * The catch, and the reason `server.ts` still exists: Slack does not allow a
 * Socket Mode app to be distributed to other workspaces. This is the right
 * transport for your own Slack. Installing into customers' Slack means moving
 * back to the HTTP events endpoint.
 */

/** Slack wants an acknowledgement within three seconds of an envelope. */
const ACK_DEADLINE_MS = 3000;

type Envelope = {
  type?: string;
  envelope_id?: string;
  payload?: { event?: SlackEvent; event_id?: string; type?: string };
  retry_attempt?: number;
  reason?: string;
};

async function openConnection(appToken: string): Promise<string> {
  const response = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}`, "content-type": "application/json; charset=utf-8" },
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (body.ok !== true || typeof body.url !== "string") {
    throw new Error(
      `apps.connections.open failed: ${String(body.error ?? "unknown_error")}. ` +
        `The app-level token must start with xapp- and carry the connections:write scope.`,
    );
  }
  return body.url;
}

/**
 * One connection, for as long as it lasts. Resolves when Slack asks us to
 * reconnect or the socket closes, so the caller can simply open another.
 */
function runConnection(url: string, onEvent: (event: SlackEvent, eventId: string) => void): Promise<void> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    socket.addEventListener("message", (message: MessageEvent) => {
      let envelope: Envelope;
      try {
        envelope = JSON.parse(String(message.data)) as Envelope;
      } catch {
        log.warn("Slack sent something that was not JSON.");
        return;
      }

      if (envelope.type === "hello") {
        log.info("Connected to Slack over Socket Mode.");
        return;
      }

      if (envelope.type === "disconnect") {
        log.info(`Slack asked us to reconnect (${envelope.reason ?? "no reason given"}).`);
        socket.close();
        finish();
        return;
      }

      // Acknowledge first, always, and before doing any work.
      if (typeof envelope.envelope_id === "string") {
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }

      if (envelope.type !== "events_api") return;

      const event = envelope.payload?.event;
      if (event === undefined || event.type !== "app_mention") return;
      if (event.bot_id !== undefined) return;

      const eventId = envelope.payload?.event_id ?? `${String(event.channel)}:${String(event.ts)}`;
      onEvent(event, eventId);
    });

    socket.addEventListener("error", () => {
      log.warn("Socket Mode connection errored.");
      finish();
    });
    socket.addEventListener("close", () => {
      log.info("Socket Mode connection closed.");
      finish();
    });

    // A socket that never says hello is a socket that will never deliver.
    setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) {
        log.warn("Slack did not complete the handshake; reopening.");
        socket.close();
        finish();
      }
    }, ACK_DEADLINE_MS * 5);
  });
}

/** Connect, and keep reconnecting. Slack cycles these sockets by design. */
export async function runSocketMode(onEvent: (event: SlackEvent, eventId: string) => void): Promise<never> {
  const appToken = config.slack.appToken;
  let backoffMs = 1000;

  for (;;) {
    try {
      const url = await openConnection(appToken);
      backoffMs = 1000;
      await runConnection(url, onEvent);
    } catch (err) {
      log.error(`Could not open a Slack connection; retrying in ${Math.round(backoffMs / 1000)}s`, err);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}
