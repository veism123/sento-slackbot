import { config, mcpUrl } from "./config.ts";
import { getSentoKey } from "./sento.ts";
import { handleMention } from "./agent.ts";
import { log } from "./log.ts";

/**
 * The Sento half, without Slack in the way. Run this first: if a question
 * comes back with real workspace content, then the key, the MCP endpoint and
 * the model call are all confirmed, and everything left is Slack app
 * configuration.
 *
 *   npm run probe -- "what shipped this week?"
 *   npm run probe -- "save this: we picked Railway for the bot host"
 */

const question = process.argv.slice(2).join(" ").trim();

log.info(`Sento base: ${config.sento.baseUrl}`);
log.info(`MCP endpoint: ${mcpUrl()}`);
log.info(config.dryRun ? "DRY RUN: reads only." : "LIVE: writes are enabled.");

const key = getSentoKey();
log.info(`Connection key present, ${key.length} characters. Not printing it.`);

if (question === "") {
  log.info('No prompt given, so stopping here. Try: npm run probe -- "what does this team mean by courier?"');
  process.exit(0);
}

const result = await handleMention(
  [
    "Slack channel: (probe, not a real channel)",
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    "Tagged by: @probe",
    "",
    `What they said to you: ${question}`,
  ].join("\n"),
);

log.info(`Tools called: ${result.toolCalls.join(", ") || "(none)"}`);
console.log("\n" + result.reply + "\n");
