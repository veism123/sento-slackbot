# midland-slack-bot

Tag the bot in Slack. It reads and writes your team's Midland context layer over
MCP.

```
@sento what did we ship this week?
   → answers from the workspace, echoing Midland's own numbers and freshness verdicts

@sento save this to the FAQ
   → files the thread into the one entity that should hold it, and says which
```

## How it works

```
Slack mention ──► POST /slack/events
                    signature verify, 200 within 3s, hand off
                    │
                    └─► Claude (Messages API, MCP connector)
                          mcp_servers: [midland]  ← bearer minted per run
                          Claude calls list_entities → get_entity →
                          get_authoring_guide → write_text/metric/list
                          │
                          └─► reply in thread + ✅ if something was written
```

Midland never runs a model — that is deliberate, and it is why the bot exists as
a separate service. Anthropic makes the MCP calls server-side, so there is no
tool loop in this repo: one `messages.stream` call does the whole exchange.

## Setup

### 1. A Midland courier credential

The bot authenticates as a courier: a machine principal with its own client id
and secret, which shows up in Midland as something you can select under who may
read and who may write an entity. A Midland operator mints it in the Midland
repo:

```bash
npm run credential:mint
```

Mint one courier for this bot rather than sharing an existing one, so revoking
the bot does not take anything else down with it, and so the bot can be named
individually in an entity's read and write rules.

What that credential can and cannot do, by what it is rather than by role:

- **Can** write content — text bodies, metric observations, list entries — to
  any entity in the workspace it is credentialed for. Once per-entity rules can
  name this courier, that is where you narrow it down, and that boundary is the
  real one: it is enforced by Midland's gate, not by this repo. The tool
  allowlist below is only a convenience on top.
- **Cannot** create an entity. Deciding a new concept is a conversation people
  have; when nothing fits, the bot says so and records the gap through
  `list_entities`' `seeking` so admins see it.
- **Cannot** write a retrieval or authoring guide, or delete a list entry.

Everything it writes serves **fenced**, because it crossed into the workspace
from outside. That is not a penalty — it is what tells a reading agent the block
is data.

### 2. The Slack app

`slack-app-manifest.yaml` in this repo is the whole configuration. At
api.slack.com/apps → **Create New App → From a manifest**, paste it, then:

- **Install to Workspace** → copy the Bot User OAuth Token (`xoxb-…`)
- **Basic Information** → copy the Signing Secret
- Invite the bot to a channel: `/invite @sento`

### 3. Fill in `.env`

```bash
cp .env.example .env
```

Five values, and nothing works until all five are real:

| Variable | Where it comes from |
|---|---|
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token |
| `SLACK_SIGNING_SECRET` | Slack app → Basic Information → Signing Secret |
| `MIDLAND_BASE_URL` | The deployed Midland instance, e.g. `https://app.example.com` |
| `MIDLAND_CLIENT_ID` / `MIDLAND_CLIENT_SECRET` | `npm run credential:mint`, above |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys |

The token endpoint is discovered from
`<MIDLAND_BASE_URL>/.well-known/oauth-authorization-server`, so you normally do
not set `MIDLAND_TOKEN_URL` or `MIDLAND_MCP_URL`.

### 4. Prove the Midland half before touching Slack

```bash
npm install
npm run probe -- "what does this team mean by a courier?"
```

If a token mints and the answer comes back with real workspace content, then
everything left is Slack configuration.

### 5. Run it

```bash
npm start
```

Slack needs a public URL. For local development, tunnel it:

```bash
ngrok http 3000
```

Put `https://<tunnel>/slack/events` into the manifest's `request_url` (Event
Subscriptions). Slack sends a one-time `url_verification` challenge; the server
answers it automatically, and the page turns green.

## DRY_RUN

`DRY_RUN=true` is the default. Reads work normally; the write tools are not
handed to the model at all, and it reports what it *would* have written and
where. Watch it pick the right entity a few times before setting
`DRY_RUN=false`.

## Deploy

Any always-on host — Railway, Fly, a small VM. `npm start`, one process, no
database. Set every variable from `.env.example` in the host's environment
rather than shipping a `.env`.

The only state is an in-memory set of handled Slack event ids, which exists so a
Slack retry does not file the same message twice. A restart forgets it; the
window that matters is minutes, so that is an acceptable trade for having no
database.

## What is not built

- **DMs.** The bot answers `app_mention` only. A DM surface means deciding what
  a message with no mention in it means.
- **Confirm-before-write.** A write happens as soon as Claude decides on one.
  If you want a human in the loop, the shape used elsewhere is propose in
  thread, write on 👍 — that needs somewhere to persist the pending proposal.
- **Per-person identity.** Everyone in Slack writes as this one credential.
  Attribution is carried in the content ("via @handle in Slack"), not in
  Midland's own provenance, which records the machine writer. Fine for a team
  dogfooding it; think again before a customer's Slack is connected.

## Tests

```bash
npm test        # signature verification, mention parsing
npm run typecheck
```
