import { config } from "./config.ts";
import { log } from "./log.ts";
import { dispatch } from "./handle.ts";
import { runSocketMode } from "./socket.ts";
import { startHttpServer } from "./server.ts";

/**
 * Two ways in, chosen by whether an app-level token is configured.
 *
 * Socket Mode (SLACK_APP_TOKEN set) is right for your own Slack: the bot dials
 * out, so there is no public URL to arrange and nothing to expose.
 *
 * HTTP mode is what you move to when the app has to be installable by other
 * workspaces, because Slack does not allow Socket Mode apps to be distributed.
 */

log.info(`Sento: ${config.sento.baseUrl}`);
log.info(`Model: ${config.anthropic.model}`);
log.info(config.dryRun ? "DRY RUN: reads only, nothing will be written." : "LIVE: writes are enabled.");

if (config.slack.hasAppToken) {
  log.info("Socket Mode: no public URL needed.");
  await runSocketMode(dispatch);
} else {
  startHttpServer();
}
