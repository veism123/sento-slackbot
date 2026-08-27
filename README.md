# sento-slackbot

Slack bot for the Sento context layer: tag it to ask questions answered from
the workspace, or to file decisions and threads into it over MCP.

```
@sento what did we ship this week?
   → answers from the workspace, echoing Sento's own numbers and freshness verdicts

@sento save this to the FAQ
   → files the thread into the one entity that should hold it, and says which
```

## How it works

```
Slack mention ──► Socket Mode (or POST /slack/events in HTTP mode)
                    ack, hand off
                    │
                    └─► Claude (Messages API, MCP connector)
                          mcp_servers: [sento]  ← connection key as bearer
                          Claude calls list_entities → get_entity →
                          get_authoring_guide → write_text/metric/list_entry
                          │
                          └─► reply in thread + ✅ if something was written
```

Sento never runs a model — that is deliberate, and it is why the bot exists as
a separate service. Anthropic makes the MCP calls server-side, so there is no
tool loop in this repo: one `messages.stream` call does the whole exchange.

**Thread follow-ups need no re-tag.** Once the bot has replied in a thread,
further messages in that thread reach it without a new mention. Only there:
plain channel messages are ignored, so starting a conversation still takes a
tag. Recognition survives restarts — on a cache miss the bot checks the thread
itself for one of its own replies.

Being in the thread earns a message a hearing, not an answer: a small, fast
model call (the intent gate) reads the tail of the thread and decides whether
the newest message is directed at the bot at all. People talking to each
other in a bot thread are left alone. The gate fails closed — when unsure it
stays quiet, and a missed follow-up costs one re-tag.

## Setup

### 1. A Sento connection key

The bot authenticates as a **courier**: a machine connection that shows up in
Sento as something you can select under who may read and who may write an
entity. A workspace admin creates it from the **Members panel**: name the
connection, and the key is shown once ("Bot is connected"). Copy it then — it
is not recoverable, and losing it means revoking the connection and adding
another.

The key does not expire and is the entire credential: it is sent as the
`Authorization` bearer on every request, with no token to mint or refresh. A
`401` therefore always means the key was revoked — the bot stops and says so
rather than retrying.

Create one connection for this bot rather than sharing an existing one, so
revoking the bot does not take anything else down with it, and so the bot can
be named individually in an entity's read and write rules.

### 2. Grants: what the bot can see and touch

A new connection can read and write **nothing**. Both are granted per entity,
on the entity's card in Sento:

- **"Who can read?"** — add the connection on every entity the bot should
  answer questions from. A courier sees only entities that name it; everything
  else in the workspace is invisible to it, which is the fence working, not a
  broken credential.
- **"Who can write?"** — add it only on the entities it should file into. The
  write grant carries its own read.

If the bot answers "the workspace holds nothing on that yet" about things you
know exist, it is missing read grants, not broken.

What the credential can never do, by what it is rather than by role: create an
entity (it records the gap via `list_entities`' `seeking` instead), write a
retrieval or authoring guide, or delete a list entry. Everything it writes is
served **fenced**, because it crossed into the workspace from outside — that
is what tells a reading agent the block is data, not instructions.

### 3. The Slack app

`slack-app-manifest.yaml` is the whole configuration. At api.slack.com/apps →
**Create New App → From a manifest**, paste it, then:

- **Basic Information → App-Level Tokens → Generate.** Give it the
  `connections:write` scope. This is the `xapp-…` token.
- **Install to Workspace** → copy the Bot User OAuth Token, the `xoxb-…` one.
- Invite the bot to a channel: `/invite @sento`

The manifest turns on **Socket Mode**: the bot opens an outbound connection to
Slack rather than Slack calling in. No public URL, no tunnel, nothing exposed
to the internet. Socket Mode apps cannot be distributed to other workspaces;
`src/server.ts` holds the HTTP events endpoint for when the app has to be
installable by customers — leave `SLACK_APP_TOKEN` out of the environment and
the bot starts in that mode instead.

### 4. Fill in `.env`

```bash
cp .env.example .env
```

| Variable | Where it comes from |
|---|---|
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token |
| `SLACK_APP_TOKEN` | Slack app → Basic Information → App-Level Tokens |
| `SENTO_BASE_URL` | The deployed Sento instance, e.g. `https://app.sentohq.com` |
| `SENTO_CONNECTION_KEY` | Members panel → the connection's key, shown once |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys |

`SLACK_SIGNING_SECRET` is only needed in HTTP mode. The MCP endpoint defaults
to `<SENTO_BASE_URL>/api/mcp`, so you normally do not set `SENTO_MCP_URL`.
The key goes in the environment (the host's secret manager in production),
never in source. Paste it bare: no quotes, no angle brackets.

### 5. Prove the Sento half before touching Slack

```bash
npm install
npm run probe -- "what does this team mean by a courier?"
```

No Slack involved. If the answer comes back with real workspace content, then
the key, the MCP endpoint and the model call are all confirmed, and anything
left is Slack configuration.

### 6. Run it

```bash
npm start
```

Then in Slack:

```
@sento summarize what we just decided
```

## DRY_RUN

`DRY_RUN=true` is the default. Reads work normally; the write tools are not
handed to the model at all, and it reports what it *would* have written and
where. Watch it pick the right entity a few times before setting
`DRY_RUN=false`.

## Deploy

Any always-on host that runs a long-lived process — a Hetzner box with
Coolify, Railway, Fly, a small VM. `npm start`, one process, no database, and
in Socket Mode no inbound networking, so it needs no domain, no port, and no
certificate. Set every variable from `.env.example` in the host's secret
manager rather than shipping a `.env`, and disable any HTTP health check —
this is a worker, not a website.

Serverless platforms (Vercel, Lambda) are a poor fit: Socket Mode needs a
persistent process, and the HTTP mode's ack-then-work shape fights function
lifetimes.

The only state is an in-memory set of handled Slack event ids, which exists so
a Slack retry does not file the same message twice. A restart forgets it; the
window that matters is minutes, so that is an acceptable trade for having no
database.

## Guardrails

What stops chat from becoming chaos is layered, and most of the layers are
Sento's, not this repo's:

- **Off-topic questions dead-end politely.** The bot answers only from the
  workspace. Anything the workspace does not hold gets "the workspace doesn't
  hold that yet", never the model's own guess.
- **Junk cannot land anywhere it wasn't invited.** Writes pass Sento's gate:
  only entities whose "Who can write?" names this connection accept anything,
  entity creation and guide writes are refused outright, and everything the
  bot writes serves fenced — marked as relayed data no reading agent should
  obey. `DRY_RUN=true` holds all writes regardless.
- **Slack text is material, never orders.** The bot reads, summarizes, and
  files the conversation; instructions inside it are content to record, not
  commands to follow.
- **The intent gate keeps it out of other people's conversations**, and the
  invite model is the channel control: the bot only hears channels someone
  `/invite`d it into.
- **Too thin to file means nothing is filed.** A vague message gets a request
  for one more line, not a vague entry that looks like a record.

## When it goes quiet

Three things fail silently, in the order to check them:

1. **The process** — is it running? (Host logs; look for
   `Connected to Slack over Socket Mode.`)
2. **The key** — a `401` anywhere means revoked, never expired. Only a
   workspace admin can issue a new one, and grants do not carry over to a new
   connection.
3. **The grants** — does each entity's "Who can read?" / "Who can write?"
   still name this connection?

## What is not built

- **DMs.** The bot answers `app_mention` only. A DM surface means deciding
  what a message with no mention in it means.
- **Confirm-before-write.** A write happens as soon as Claude decides on one.
  If you want a human in the loop, the shape used elsewhere is propose in
  thread, write on 👍 — that needs somewhere to persist the pending proposal.
- **Per-person identity.** Everyone in Slack writes as this one credential.
  Attribution is carried in the content ("via @handle in Slack"), not in
  Sento's own provenance, which records the machine writer. Fine for a team
  dogfooding it; think again before a customer's Slack is connected.

## Tests

```bash
npm test        # signature verification, mention parsing
npm run typecheck
```
