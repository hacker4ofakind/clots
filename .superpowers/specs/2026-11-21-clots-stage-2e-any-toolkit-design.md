# Clots stage 2e follow-up: any Composio toolkit

Date: 2026-11-21
Status: approved in brainstorming. Not built.
Builds on: `.superpowers/specs/2026-11-19-clots-stage-2e-composio-design.md`
(stage 2e, built), which this document extends; section numbers written "2e
section N" refer to it. Recipes: `.superpowers/specs/2026-10-14-clots-stage-2c-sources-design.md`
sections 14 and 15. This is a follow-up that finishes stage 2e, not a stage of
its own.

## 1. What it delivers

Adding a service Composio has a toolkit for should need no work in this
repository.

- **Any toolkit connects from one entry** in `sources.composio`, whatever its auth
  scheme: an API key, a key of several fields, Composio's managed OAuth app, or an
  OAuth app of the user's own. Today only a single-field API key works for a
  toolkit without built-in support (2e section 4), and the managed sign-in is
  written for the calendar alone.
- **The Clots extend the integrations themselves.** A Clot researches a toolkit,
  writes a Composio recipe that turns its trigger payloads into proper events,
  with enrichment and the self-caused drop, tries it on real payloads, and hands
  the user the configuration entry to add. The recipe is declarative data, never
  code.
- **A toolkit with no triggers** gets its events from a watch recipe on one of
  its read tools.

The daemon never loads or runs anything a Clot wrote. It holds
`COMPOSIO_API_KEY`, which reaches every connected account, and the Clots read
outsider text: code a Clot could put into the daemon would give a crafted message
the daemon's reach. A Composio recipe is checked by a schema, like the webhook
and watch recipes of 2c, and can do only what the schema allows.

## 2. Checked live before designing

Composio's metadata, read with the project's key, without making connections:

- `toolkits.get` gives each toolkit's auth schemes, the ones Composio manages,
  and each scheme's connection fields (`getConnectedAccountInitiationFields`
  gives the same per scheme).
- Slack has only OAuth, managed by Composio, and nine triggers, all of them
  webhook triggers.
- Reddit has managed OAuth and no triggers at all.
- Supabase has managed OAuth, or an API key whose connection needs two fields,
  `full` and `bearer_token`. So a key cannot always be sent as `generic_api_key`,
  as 2e does for every key.
- `triggers.listTypes` gives each trigger's type (webhook or polled) and its
  config schema; `triggers.getType` gives one trigger's details.

## 3. Connecting any toolkit

Nothing in connecting an account is specific to a toolkit any more. The daemon
reads the toolkit's auth schemes, whether Composio manages one, and the exact
fields a connection needs from Composio, and the account's entry (section 4)
says which way it connects. This replaces the key and calendar paths of 2e
section 3 for every account, built-in or not.

- **A key** (`apiKey` or `fields`): an auth config with the toolkit's key scheme
  (`API_KEY`, `BEARER_TOKEN`, `BASIC` and so on; `scheme` picks one when the
  toolkit has several), and a connection made with `connectedAccounts.initiate`
  and the fields read from `.env`, active at once. `apiKey` fills the scheme's one
  required field under that field's own name. When a value in `.env` changes,
  the connection is replaced, as 2e replaces it for a changed key.
- **Composio's managed OAuth app** (neither a key nor `oauthApp`), when Composio
  offers one: the calendar, Slack, Reddit and most OAuth services. The connection
  is made with `connectedAccounts.link`. The daemon posts the sign-in link,
  naming the toolkit by Composio's display name, in the channel of the Clot the
  account is bound to (the home Clot's, for a shared account), and waits for it to
  become active, as 2e does for the calendar.
- **An OAuth app of the user's own** (`oauthApp`): an auth config with the
  `OAUTH2` scheme and the app's client ID and secret from `.env`, then the same
  sign-in link. For a toolkit Composio has no managed app for, or whose webhook
  triggers need the user's own app.
- The sign-in should be made as the Clots' own account at the service, as
  Linear's key is the Clots' member's (2e section 8). The sign-in message says so.
- **A mismatch**: a toolkit with no scheme the entry fits, or a required field
  the entry does not give, is reported once in the account's Clot channel,
  naming the schemes the toolkit accepts and each one's fields. The account stays
  unconnected; nothing else is held up.
- Accounts already connected stay as they are: a built-in toolkit's key resolves
  to the scheme and field it uses now, so upgrading replaces no connection.

## 4. Configuration

Two new entries in `sources.composio`, next to 2e section 4's:

```json
{ "toolkit": "slack", "account": "work", "shared": true, "audience": "team", "triggers": [{ "slug": "SLACK_CHANNEL_MESSAGE_RECEIVED", "config": { "channel_id": "C0123" } }] },
{ "toolkit": "supabase", "account": "encryptify", "clot": "encryptify", "audience": "team", "fields": { "full": "SUPABASE_ENCRYPTIFY_URL", "bearer_token": "SUPABASE_ENCRYPTIFY_KEY" } }
```

For any toolkit without built-in support:

- **`apiKey`**: now optional.
- **`fields`** (in place of `apiKey`): the connection's fields as Composio names
  them, each mapped to the `.env` key holding its value, for a key scheme of more
  than one field.
- **`scheme`**: which key scheme, when the toolkit has more than one. Without it,
  the only key scheme the toolkit has.
- **`oauthApp`**: `{ "clientId": "<.env key>", "clientSecret": "<.env key>" }`,
  the user's own OAuth app. Not given with a key.
- An entry with none of `apiKey`, `fields` and `oauthApp` connects through
  Composio's managed OAuth app.
- **`selfIsUser`**: `true` when the connection is the user's own account at the
  service, not the Clots'. Then the recipe's `identity` (section 5) is not used:
  the user's own messages are not dropped as the Clot's, and only the drop of
  what the Clots' own writes touched applies (2e section 5). Default `false`.
- **`triggers`**: as in 2e. A trigger the toolkit's Composio recipe maps becomes
  the event the recipe describes; any other becomes 2e's generic `trigger` event.
  Both are marked as from an outsider.

## 5. Composio recipes

A Composio recipe describes one toolkit's trigger payloads and applies to every
account of that toolkit:

```yaml
composio:
  - name: slack
    toolkit: slack
    identity: { tool: SLACK_AUTH_TEST, path: user_id }
    triggers:
      SLACK_CHANNEL_MESSAGE_RECEIVED:
        kind: message
        id: "{payload.channel}:{payload.ts}"
        actorId: "{payload.user}"
        actor: "{enrich.user.user.real_name}"
        title: "Message in #{enrich.channel.channel.name}"
        body: "{payload.text}"
        ref: "{payload.ts}"
        place: "{payload.channel}"
        subject: "slack:{payload.channel}:{payload.thread_ts}"
        objects: ["{payload.channel}:{payload.ts}"]
        automatedWhen: { payload.subtype: bot_message }
        enrich:
          - { as: channel, tool: SLACK_CONVERSATIONS_INFO, args: { channel: "{payload.channel}" } }
          - { as: user, tool: SLACK_USERS_INFO, args: { user: "{payload.user}" } }
```

- **Templates** fill `{path}` as the other recipes do (a missing path gives
  nothing). They read `payload`, the trigger's payload, and `enrich.<as>`, the
  data of each of the recipe's own reads. Nothing else is in reach.
- **`kind`** and **`title`** are required. `kind` follows the rulebook's rule for
  kinds, and a recipe's kinds are known for its toolkit's source, so routing and
  other rules can name them. Every other field is optional and falls back as 2e's
  generic mapping does: the `id` to the delivery's, the `actor` to `unknown`, the
  `body` to the payload, the `subject` to `<toolkit>:<slug>`, and `url`, `ref`
  and `place` to empty.
- **Event ID**: `<toolkit>:<account>:<the filled id>`, or `composio:<webhook-id>`
  when the `id` is absent or fills empty. A repeat is dropped as for every source.
- **`identity`**: a read tool and the path of the connection's own user ID in its
  data. With it and `actorId`, events whose actor is the connection are dropped as
  self-caused (2e section 6), and standing rules wait for it as they do for the
  built-in sources. Not used for an account with `selfIsUser`.
- **`objects`**: the service's IDs of the objects the event is about, for the
  drop of what the Clots' own writes touched (2e section 5).
- **`automatedWhen`**: as in a webhook recipe, path-and-value pairs that make the
  event automated.
- **`enrich`**: at most 3 reads per trigger, run in order on the account's own
  session before the event is routed; a later read's arguments may use an
  earlier read's data. Only a tool that the rating (2e section 11) counts as a
  read, of the recipe's own toolkit, may be named, checked when the recipe is set
  and again before each call. Each call counts against the allowance. A read that
  fails leaves a line saying so in the body, and the event goes on with that
  read's data empty. Intake does not wait for these reads: the delivery is
  answered first, and the reads run in the pipeline's enrichment step.
- **Outsider**: a recipe's events are always an outsider's. A recipe cannot
  change that, nor how any write is rated, nor add an undo.
- **Limits**: a recipe cannot name a toolkit that has a built-in mapping (Stripe,
  Linear, Notion, Google Calendar, PostHog). A trigger the recipe does not list is
  mapped generically. Two recipes for one toolkit: the first in file order is in
  force and the other is reported, as two recipes of one name are now.
- **Where it lives**: in `global.yaml` or a Clot's own file, under `composio:`,
  and is added, replaced and removed as webhook recipes are (2c section 15):
  applied and posted with its undo, or put to the user when the turn came from an
  outsider's text. Its events are routed by the account's binding, not by the file
  it is in.

## 6. Samples

For every toolkit without a built-in mapping, the daemon keeps the last 5
payloads of each trigger of each account, for 7 days, so a recipe is written and
tried against real deliveries. A payload is kept up to 64 KB; a longer one is
kept clipped and shown as partial. The same kept payload is what the recipe's
enrichment reads from, so a delivery is kept for at least an hour whatever the
count.

## 7. Watch recipes on Composio read tools

A toolkit with no triggers (Reddit has none) gets events from a watch recipe (2c
section 14) that names a Composio account (`account: reddit:me`) in place of an
MCP server, and one of its read tools. Everything else about watch recipes holds.
The interval is at least 15 minutes, a tool that is not a read is refused, and
every run counts against the allowance. The calendars' polling and these watches
may use at most 10,000 calls a month in all (replacing 2e section 13's limit for
the calendars alone), checked when the configuration and the rulebook load; a
watch that would pass it is refused with the reason.

## 8. The Clot's tools

In the main session, with the rulebook tools, when any Composio account is
configured:

| Tool | Effect |
|---|---|
| `composio_toolkit(toolkit, trigger?)` | What Composio says of a toolkit, connected or not: its auth schemes, whether Composio manages one, each scheme's connection fields, its triggers with their type (webhook or polled), and its tools marked read or write. With a trigger, that trigger's config and payload schemas. Only reads. |
| `composio_samples(account, trigger?)` | The kept payloads of an account's triggers, newest first, wrapped as untrusted data. |
| `composio_recipe_try(recipe, account, sample or payload)` | Runs a draft recipe on a kept sample or on a payload the Clot gives, including its enrichment reads on the connected account, and shows the event it would make, or why it does not fit. Records nothing. |
| `composio_recipe(action, file, recipe)` | Sets or removes a Composio recipe, as `webhook_recipe` does. When set, every tool it names is checked: it exists, belongs to the toolkit, and is a read. |

## 9. The skill

The daemon ships a skill, `composio-integration`, in a local plugin of its own
(`plugin/` in the repository). Whenever a Clot's container starts, the daemon
copies the plugin into the Clot's home, replacing what is there, so it changes
with the daemon, and the main session loads it. (The home folder is the Clot's
own volume, so a file built into the image would be hidden, and the sessions load
no settings of their own, so a skill in `~/.claude/skills` would not be found.)
It takes the Clot through adding a service:

1. Read the toolkit with `composio_toolkit`, and the service's own documentation
   for what its payloads mean.
2. Choose the triggers: webhook ones first. When a toolkit has only polled
   triggers, or none, say so to the user and propose a polled trigger or a watch
   recipe, with what each costs of the allowance, and wait for the user's answer.
3. Choose the auth: Composio's managed app when there is one; otherwise the key
   scheme and its fields, or the user's own OAuth app when the triggers need it.
   Ask whether the Clots have an account of their own at the service; if the
   connection will be the user's own, the entry gets `selfIsUser`.
4. Give the user the exact `sources.composio` entry, any `.env` keys to add, the
   audience it suggests and why, and that a restart applies it. Only the user
   edits `clots.config.json` and `.env`; a secret never goes in a message or a
   recipe.
5. Once the account is connected and a sample has arrived, write the recipe, try
   it on every kept sample, and set it.
6. Report what the Clot will now see from the service, and what it will not.

The system prompt's Composio lines gain one: to add a service, use the skill.

## 10. Components

| Component | Responsibility |
|---|---|
| Composio (2e) | Connects every account through the choice of section 3; keeps the delivered payloads of section 6. |
| Auth choice | Pure: the entry and Composio's metadata in, the way to connect or the reason it cannot out. |
| Composio recipes | The schema, the mapping at intake, and the enrichment of section 5. |
| Watches (2c) | Call either an MCP server or a Composio account. |
| Plugin installer | Puts the daemon's plugin into each Clot's home at container start. |

## 11. Failure handling

- **An entry that does not fit the toolkit's auth**: reported once per start with
  what the toolkit accepts (section 3); its triggers and tools wait.
- **Composio's metadata cannot be read**: the account's connection is retried with
  its growing wait, as any other connection step in 2e.
- **A recipe that no longer fits its payloads**: a template that fills empty falls
  back as section 5 says, and a failed read is a line in the body, so a changed
  payload never loses an event. A recipe that does not fit the schema is reported
  as any rule file is, and its toolkit is mapped generically until it is fixed.
- **A recipe's read tool that is not a read** (Composio changed its tags, or the
  file was edited by hand): not called; a line in the body says so.
- **The plugin cannot be copied**: logged; the Clot starts without the skill.

## 12. Testing

- Choosing the auth, against recorded toolkit metadata (Slack, Reddit, Supabase,
  and one with no managed app): managed sign-in, a one-field key under its own
  field name, a two-field key, the user's own OAuth app, each mismatch with its
  message, and every built-in toolkit resolving to what it uses now.
- Composio recipes: the schema (a built-in toolkit, a write tool in `enrich`, more
  than 3 reads refused), the mapping of a recorded Slack payload with its
  enrichment against a fake Composio, each fallback, the self-caused drop through
  `identity` and `actorId`, `selfIsUser`, and the intake handling a recipe's
  trigger and an unlisted one.
- `composio_recipe_try` on a kept sample, and the samples' limits.
- A watch recipe on a Composio read tool, and the monthly limit refusing one.
- The plugin is installed into a container's home and replaced on the next start.

## 13. Done when

- Every account connected before is still connected, with no new connection,
  trigger or sign-in.
- Slack is connected with only a configuration entry, through Composio's managed
  sign-in. Following the skill, the home Clot writes and sets a Slack recipe from
  a kept sample, and a message in the watched channel then reaches it as a
  `message` event with the channel's and author's names, while the Clot's own
  message in that channel does not.
- Supabase connects with its two-field key from `fields`, and the Clot reads
  through its tools.
- Reddit connects through the managed sign-in, and a watch recipe on its read
  tool for a subreddit's new posts makes events.

## 14. Not in this follow-up

- Recipes that change how a toolkit's writes are rated, or add inverses for
  `&composio undo`: both would let a Clot widen what it may do unasked.
- Code written by a Clot, run by the daemon (section 1).
- Moving Linear and Notion to webhook triggers through `oauthApp`: it makes them
  reachable, but their built-in mappings are written for what they use now.
- Upgrading `@composio/core`.
