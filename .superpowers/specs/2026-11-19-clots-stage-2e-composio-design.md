# Clots stage 2e: Composio

Date: 2026-11-19
Status: approved in brainstorming. Not built.
Parent design: `.superpowers/specs/2026-10-10-clots-design.md`. This document
specifies stage 2e (section 16 there). It builds on stages 2a to 2d, on global
memory, on the main session and workers, and on autonomy.

## 1. What 2e delivers

Composio (composio.dev) becomes the daemon's layer for third-party services: it
holds the connections, sends their events to one webhook, and runs their tools.

- Stripe, Linear, Notion and Google Calendar are connected through Composio, with
  the Clots' own keys (the calendar through Composio's managed Google sign-in).
  Their own webhook adapters (except Notion's), the iCal poller and the Apps Script go.
  Notion's events keep stage 2c's own webhook, because Composio's Notion triggers
  need a Notion OAuth app that an API-key connection does not have; its reads and
  comments go through Composio.
- PostHog, specified in 2c and not yet built, is connected through Composio too.
- Any other service Composio has a toolkit for can be added as an account, with
  its triggers as events and its tools for the Clot.
- The Clot can act in these services. Reads run in every turn. A write is decided
  by the account's audience (private, team or public), Composio's tags on the
  tool, a fixed list of what always asks, and, for destructive writes in a team
  workspace, a Haiku 5.5 reviewer. Most writes therefore need no ask.

GitHub and email stay as built: GitHub's pipeline needs its full payloads, inline
review comments and the self-caused drop, and email's IMAP IDLE is faster than
Composio's polled Gmail trigger. Sentry and Vercel stay specified as built-in
webhooks (2c section 16): Composio has no triggers for either. Webhook recipes,
watch recipes and the sweep stay for what Composio does not cover.

## 2. Where 2e sits in the parent design

2e changes these parts of the parent design, and is where each is specified in
full:

- **Components** (parent section 2): a Composio component, and the write reviewer.
- **Intake** (parent section 9): the Composio webhook and the sources moved to it.
- **Permissions** (parent section 7): account audiences, the rating of Composio
  tools, and the reviewer.
- **Stages** (parent section 16): 2e comes after 2d and before stage 3, whose
  onboarding checklist includes Composio connections.

## 3. Composio, as Clots uses it

- **One Composio project**, made under the Clots' own email address. Its API key is
  `COMPOSIO_API_KEY` in `.env`. Only the daemon reads it; it never enters a
  container, since it can use every connected account.
- **Plan**: the free Hobby plan: 100,000 tool calls and 50,000 trigger events a
  month, of which 20,000 calls and 10,000 events on Composio-managed apps (here,
  the calendar). It is hard-capped: at a cap, usage pauses until the next month,
  and nothing is billed.
- **Library**: `@composio/core`, pinned to an exact version. Tools are run through
  a session (`composio.create(user, { toolkits, sandbox: disabled })` and
  `session.execute`), the path Composio prices as ordinary tool calls. The
  remote sandbox is disabled: the Clots have computers of their own.
- **Users**: Composio expects one user per end user. Clots has one owner, so each
  configured account is its own Composio user, named `<toolkit>:<account>`
  (`linear:proton`). A session belongs to one account, so a tool call can only
  ever reach the account it names.
- **Auth configs and connections are made by the daemon**, not in Composio's
  dashboard. At startup, for each account in the configuration, it makes sure an
  auth config exists for the toolkit and a connected account exists for the
  account's user:
  - an account with a key: an auth config with the `API_KEY` scheme, and a
    connection made with `connectedAccounts.initiate` and the key read from
    `.env`, active at once. When the key in `.env` changes, the connection is
    replaced.
  - the calendar: Composio's managed Google app. The connection is made with
    `connectedAccounts.link`; the daemon posts the sign-in link in the channel of
    the Clot the account is bound to (the home Clot's, for a shared account), as
    it does for an OAuth MCP server (2c section 13), and waits for it to become
    active.
- **Trigger instances are made by the daemon** too: for each account, the
  triggers its source section names, created when missing and removed when the
  account leaves the configuration. Each instance's ID is stored with its account.

## 4. Configuration

Composio accounts live under `sources.composio` in `clots.config.json`, one list
for every toolkit:

```json
"sources": {
  "composio": [
    { "toolkit": "linear", "account": "proton", "clot": "encryptify", "audience": "team", "apiKey": "LINEAR_PROTON_KEY" },
    { "toolkit": "notion", "account": "main", "shared": true, "audience": "private", "apiKey": "NOTION_CONNECTION_API_KEY" },
    { "toolkit": "stripe", "account": "encryptify", "clot": "encryptify", "audience": "public", "apiKey": "STRIPE_ENCRYPTIFY_KEY" },
    { "toolkit": "googlecalendar", "account": "personal", "shared": true, "audience": "private", "leadTimes": ["24h"], "pollMinutes": 5 },
    { "toolkit": "posthog", "account": "encryptify", "clot": "encryptify", "audience": "public", "apiKey": "POSTHOG_ENCRYPTIFY_KEY", "region": "us", "projectId": 123456, "events": ["signup"] }
  ]
}
```

- **`toolkit`**: Composio's toolkit slug. The four in sections 7 to 10 and PostHog
  have events and enrichment specified here. Any other toolkit gives the Clot its
  tools, and events from the triggers named in `triggers`.
- **`account`**, **`clot`** or **`shared`**: as for every source (2c section 5).
  Routing is unchanged: a bound account's events go to its Clot; a shared
  account's go through routing rules, the routing call and the home Clot. In
  routing rules and events, `source` is the toolkit's name as Clots knows it
  (`stripe`, `linear`, `notion`, `calendar`, `posthog`), or the toolkit slug for
  any other.
- **`audience`**: `private`, `team` or `public` (section 11). Default `public`.
- **`apiKey`**: the `.env` key of the service's key. Absent for the calendar.
- **`region`, `projectId`, `events`** (PostHog only): `us` (the default) or `eu`; the
  project to watch; and the names of the analytics events that become events here.
  The key needs the `hog_function:write` scope, which Composio uses to register its
  destination.
- **`triggers`** (any other toolkit only): a list of Composio trigger slugs, each
  with its `config`. Their events are of kind `trigger`, titled by the trigger's
  name and carrying the payload as their body. Since the daemon cannot tell who
  wrote what such a payload carries, these events are marked as from an
  outsider.
- `sources.stripe`, `sources.linear`, `sources.notion` and `sources.calendar` no
  longer exist. A configuration that still has one fails to load, naming the key
  and pointing at `sources.composio`.

## 5. Intake

- One path, `/webhooks/composio`, answers every Composio delivery. At startup the
  daemon sets the project's webhook subscription to `<publicUrl>/webhooks/composio`
  (version V3, event `composio.trigger.message`), and stores the subscription's
  secret in its database. The secret is never shown in chat.
- **Verifying**: `webhook-signature` is `v1,` and a base64 HMAC-SHA256 of
  `<webhook-id>.<webhook-timestamp>.<raw body>` with the subscription's secret,
  compared in constant time. A `webhook-timestamp` more than 300 seconds from the
  daemon's clock is refused. The daemon does this itself: the library's
  `verifyWebhook` rejects any body outside its own schema.
- **Repeats**: the event ID is the one 2c gave each source, built from the
  service's own ID (`stripe:<account>:<evt_…>`, and so on), so a service's retry,
  a recreated trigger, or two triggers reporting one thing make one event. A
  generic toolkit's event is `composio:<webhook-id>`. A stored ID is
  acknowledged and ignored, as for every source.
- **Lifecycle events**: the subscription also takes `composio.trigger.disabled`
  and `composio.connected_account.expired`. A trigger disabled for any reason but
  an expired connection is recreated once (and the user told if that fails); an
  expired connection is told once, with a new sign-in link for the calendar.
  A disabled trigger's `data.id` is the trigger instance and `data.disabled_reason`
  says why; an expired connection's `data.id` is the connection.
  The daily check of section 13 stays as a backstop.
- **The Clot's own writes**: an event about an object one of the Clot's
  Composio writes created or changed in the last 10 minutes is dropped as
  self-caused, whoever the service names as its actor.
- **Notion**: its events do not pass here. They arrive at stage 2c's path,
  `/webhooks/notion/<account>`, with 2c's verification and handshake.
- **Account**: the payload's connected account ID is looked up in the stored
  connections. An unknown one is logged, acknowledged and discarded.
- **Mapping**: each trigger slug has a function that turns its payload into the
  common event (parent section 3); the source sections give each. A trigger with
  no mapping, on a toolkit sections 7 to 10 cover, is logged and discarded.
- From there the pipeline is unchanged: self-caused drop, enrichment, pre-filters,
  routing, hold, triage.

## 6. Reading through Composio

- **Self-caused drop**: for each account, the daemon learns the connection's own
  user ID once, with a read tool ("who am I"), and drops events whose actor is
  that ID. Until the read has worked it is retried with a growing wait, up to an
  hour, and no standing rule sends on that account (as in 2c sections 11 and 12).
- **Enrichment** reads through Composio's read tools on the account's own session,
  in place of each service's own client. What is read is unchanged from 2c and
  listed in each source section. A read that fails leaves a line saying so, and
  the event goes on.
- **Composio's trigger payloads are smaller than the services' own webhooks.** The
  enrichment fills what the event needs; nothing relies on a field a trigger may
  leave out.

## 7. Stripe

- **Triggers**: Composio's Stripe triggers for the events of 2c section 8's table
  that Composio offers (`invoice.payment_failed`, `payment_intent.payment_failed`,
  `charge.dispute.created`, `customer.subscription.deleted`, `payout.failed`,
  `charge.refunded`, and `checkout.session.completed` when `checkoutCompleted` is
  `true`). Composio has no trigger for `radar.early_fraud_warning.created` or
  `invoice.overdue`, so those two kinds are not delivered. Composio creates the
  webhook destination in Stripe itself.
- **Key**: a restricted key with read access as in 2c, and read and write access to
  webhook endpoints, which Composio needs to find and create its destination.
- **Kinds, the event and enrichment**: as in 2c section 8. `actor` is the
  customer's email address, or `stripe`. Every Stripe event is automated.
- **Writes**: every Stripe tool that is not read-only is on the fixed list
  (section 11): money is at stake. The key cannot write anything else anyway.

## 8. Linear

- **Triggers**: issue created and comment created, for each team the Clots' member
  belongs to (`LINEAR_PRIVATE_TEAM_ISSUE_CREATED` and
  `LINEAR_PRIVATE_TEAM_COMMENT_CREATED`). Composio polls these every minute; its
  webhook triggers need a Linear OAuth app, which a key connection does not have.
  An issue arrived 26 seconds after it was made. The payload carries the team key,
  the creator, the issue's URL and identifier.
- **Key**: the Clots' member's personal API key, as in 2c.
- **Kinds, the event and enrichment**: as in 2c section 11: `issue_opened` and
  `comment`; `place` is the team's key; the issue with its last ten comments is
  read. An actor that is an integration or application makes the event automated.
- **Self-caused**: the actor is the Clots' member.
- **Sending**: `via: linear_comment` comments through Composio's tool, as the
  Clots' member.

## 9. Notion

- **Events**: stage 2c's webhook, unchanged: the connection's webhook points at
  `/webhooks/notion/<account>`, Notion's verification token is stored when it
  arrives, and each delivery is checked against it. Composio's Notion triggers need
  a Notion OAuth app (a public integration with a client ID and secret) that an
  API-key connection does not have, so none is made.
- **Key**: the internal connection's secret, as in 2c, held by Composio. The pages
  and databases the Clots should see are shared with the connection.
- **Kinds, the event and enrichment**: as in 2c section 12: `page_created` and
  `comment`; the page's title, properties and first 2,000 characters, the
  comment's discussion, and the author's name are read.
- **Self-caused**: the author is the connection's own bot user.
- **Sending**: `via: notion_comment` comments through Composio's tool, as the
  connection.

## 10. Google Calendar

The daemon reads and writes the user's calendar through Composio's Google
Calendar tools, on the user's own Google account signed in through Composio's
managed app. No Google Cloud project, no iCal address and no Apps Script.

- **Reading**: every `pollMinutes` the daemon lists the events of the coming 31
  days with repeating events expanded into occurrences (Google's `singleEvents`),
  in the configuration's `timeZone`. Each occurrence carries its series' ID, so
  a repeating event is known as one.
- **Reminders**: made by the daemon from that list, exactly as in 2c section 10:
  the same IDs, lead times, title, body, actor, place and subject, and the same
  rule for reminders that came due while the daemon was down. No Composio trigger
  is used: "event starting soon" counts minutes, not the lead times reminders need.
- **`calendar_list`**: as now, from the last list, with the Clots' changes of the
  last two days from the log.
- **`calendar_write`** and **`calendar_remove`**: Composio's create, update and
  delete tools. Every rule of parent section 7 stays: never an event with guests,
  never removing a repeating event, its series changed only in a turn the user's
  message started, the outsider limits, the log of what each change replaced, the
  check that a removed event is gone before it is created again, and
  `&calendar undo`. These two tools keep their own ratings in code; the rating of
  section 11 does not apply to them.
- The calendar's account has an audience like any other, but it only matters for
  the calendar tools Composio offers beyond these: any other calendar tool goes
  through `composio_run` (section 11).

## 11. Acting through Composio

### The tools

Two daemon tools, the main session's only. A worker has none; one that needs a
service asks the main session with `ask_main`.

| Tool | Effect |
|---|---|
| `composio_find(account, query)` | Searches the account's toolkit for tools that fit the query, and returns their slugs, descriptions, input schemas and tags. Only reads. |
| `composio_run(account, tool, args)` | Runs one tool on the account's session, as rated below. Returns the result, or that it became an ask, or why it was refused. |

A tool from another toolkit than the account's is refused. Each call is logged with
its account, tool, arguments and outcome.

### Audiences

Each account says who sees what happens in it:

| Audience | Meaning | Writes |
|---|---|---|
| `private` | Only the user and the Clots | Run |
| `team` | The user and people they know well, building something together | Run, but destructive ones go to the reviewer |
| `public` | Anyone else: customers, a community, strangers | Ask |

### The rating

The daemon rates every `composio_run` call in code, in this order; the first that
applies decides:

1. **Read**: the tool is tagged `readOnlyHint` by Composio. It runs, in every kind
   of turn, under the lock.
2. **Always asks**: the tool is on the fixed list below. It becomes an ask,
   whatever the audience.
3. **Public account**: an ask.
4. **An outsider's turn, in a private or team account**: a destructive write on
   something no Clot's own write created is an ask. Every other write goes to the
   reviewer.
5. **Private account**: it runs.
6. **Team account**: a write that is not destructive runs; a destructive one goes
   to the reviewer.

"Something a Clot's own write created" is checked by the daemon, against its log
of Composio writes, never taken from the model.

Composio tags each tool `readOnlyHint`, `createHint`, `updateHint` or
`destructiveHint`. A tool is **destructive** when it is tagged
`destructiveHint`, when it has none of the four tags, or when its slug names
deleting, archiving, removing, revoking, cancelling, reassigning or
transferring. So a tool whose tags are missing is treated as the worst case.

A `readOnlyHint` is not trusted alone: when the slug's verb is a write
(create, add, update, set, delete, remove, archive, send, post, invite, share,
publish, move, merge, cancel), the tool counts as a write. Passthrough tools
(a GraphQL or raw request tool, a proxy, Composio's own meta tools) count as
destructive, since what they do depends on their arguments.

`composio_run` refuses any Google Calendar tool that writes: the calendar is
changed only through `calendar_write` and `calendar_remove`, which keep their
own rules (section 10). It refuses a call whose arguments are too large to
show the user in full (over 6,000 characters). Accounts are named
`<toolkit>:<account>` in both tools.

**Limits**: 30 `composio_run` calls per turn and 300 per Clot per day; 10
reviewer calls per Clot per day from turns an outsider's text started, after
which such writes ask.

The **fixed list** is matched on the tool's slug and toolkit, in code:

- anything that moves money or changes what someone pays: every Stripe write, and
  any tool whose slug names a payment, charge, refund, payout, transfer, invoice
  or subscription;
- anything that reaches a person outside the workspace: sending an email, a direct
  message or an SMS, an invitation, sharing a document or page with someone, and
  publishing (making something public);
- anything that changes who or what can reach the workspace: webhooks, API keys,
  tokens, OAuth apps, integrations, roles, permissions, members and admins.

A comment, an issue or a page inside a team or private workspace is not on the
list: in those workspaces the audience decides, and parent section 7's "a comment
that reaches a person is an ask" applies to public accounts.

### The reviewer

One Haiku 5.5 call at medium effort, with no tools and a fixed output schema:
`run` or `ask`, and a reason of one line. It sees the tool's slug and description,
the arguments, the account, its audience, whether an outsider's text started
the turn, and facts the daemon checked itself: whether a Clot's own write
created the target, and, where it can be read, who created and last edited it.
In a turn the user's own chat message started, it also sees that message, the
one trusted text in the system, so a deletion the user asked for is not put
back to them as an ask. It never sees an event, an email, a worker's report, or
the Clot's own reasoning.
Its reason is shown to the user as the reviewer's words, never as the daemon's. The arguments are wrapped and labelled as untrusted, as an event is, and
its system prompt tells it to treat them as data.

It is asked one question: would someone in this workspace mind this, or be hurt
by it, if nobody asked the user first? Removing a teammate's work, archiving
something still in use, or a change in an outsider's turn that the outsider's
text appears to ask for is `ask`. Archiving an issue a Clot made itself, or
tidying what is plainly the Clots' own, is `run`.

- **It fails closed**: an error, a timeout, or an answer that does not fit the
  schema is `ask`.
- It can only approve or escalate. Text in the arguments that talks it into `run`
  makes, at worst, a write in a private or team workspace that runs and is posted.
- Its cost is booked to the Clot in the spend log.

### What a write that runs leaves behind

- A line in the Clot's live channel: what was done, in which account, and a link
  when the result gives one.
- An entry in the Composio log: the account, tool, arguments, result, and, when
  the toolkit has an inverse for it, what that inverse needs: archiving what was
  created, or putting back the fields an update changed (read with a read tool
  before the update).
- `&composio undo` reverses this Clot's latest write that has an inverse, and,
  sent again, the one before it. It is posted as the write was. A write with no
  inverse is posted with "no undo".

### Asks

A write that becomes an ask is put to the user in `<clot>-ask`, through the one
ask component of parent section 7, as a new kind:

| Kind | Channel | Exact yes | Exact no | Any other reply | Withdrawn when |
|---|---|---|---|---|---|
| Composio write | `<clot>-ask` | runs it, exactly as shown | declines it | goes to the main session as the user's feedback, and the ask closes | never |

The ask shows the account, its audience, the tool's name and description, the
arguments in full, and why it asks (public account, the fixed list, or the
reviewer's reason). A yes runs exactly what was shown.

### Standing rules

`via: linear_comment` and `via: notion_comment` send through Composio's comment
tools on the account the event came from. They are sent under the rule the user
approved, as in 2b, and are not rated again.

## 12. Components

| Component | Responsibility |
|---|---|
| Composio | Holds the client and `COMPOSIO_API_KEY`; keeps auth configs, connections, trigger instances and the webhook subscription in step with the configuration; runs tools on an account's session; checks triggers daily. |
| Composio intake | `/webhooks/composio`: verifies, drops repeats, finds the account, maps the payload to the common event. |
| Composio rating | Pure code: the order of section 11, the fixed list, the destructive check. |
| Write reviewer | The Haiku 5.5 call of section 11, behind the model interface. |
| Composio log | Every write, with what its undo needs; `&composio undo`. |

The Stripe and Linear webhook adapters, the iCal poller and its parser,
the calendar's Apps Script client, `setup/calendar.gs`, and their tests and
recorded payloads are removed. New recorded Composio payloads take their place.

## 13. Failure handling

- **Composio unreachable**: a tool call returns the error to the Clot, which says
  what it could not do. Enrichment goes on with a line saying so. Webhooks simply
  stop arriving.
- **A trigger silently disabled**: once a day the daemon reads each trigger
  instance's status, and recreates one that is disabled or missing. One it cannot
  recreate is reported once in its Clot's channel. A Stripe destination deleted in
  Stripe is not noticed (Composio does not hear of it and has no tool that lists
  Stripe's webhook endpoints); removing the account from the configuration,
  restarting and adding it back makes it again.
- **A connection expired or revoked**: reported once in its Clot's channel: for
  the calendar with a new sign-in link, for a key with the `.env` key to replace.
  Its tool calls and enrichment fail until then.
- **A cap reached**: Composio refuses tool calls and stops delivering events until
  the month resets. Reported once in the home Clot's channel (or the first
  Clot's), with the date usage resumes.
- **Calendar poll fails**: retried with a growing wait, as every listener is (2c
  section 6).
- **A call hangs**: every Composio call and the reviewer time out after 30
  seconds. A write that timed out is posted as "outcome unknown", is never
  retried by the daemon, and has no undo.
- **Composio answers in an unexpected shape**: the daemon's own calls check the
  fields they rely on; on a mismatch enrichment says it could not read, a
  calendar change is refused, and the daily check tells the user once per tool
  and account per start, in the account's Clot channel.
- **The allowance runs low**: the daemon counts its tool calls and deliveries
  each month and warns once at 70% and once at 90% of each Hobby allowance. The
  calendars' polling may use at most 10,000 calls a month in all, checked when
  the configuration loads.
- **Startup**: nothing Composio does holds up the daemon's start. Each account
  connects on its own, with its own retries.
- **Daemon down**: nothing relies on Composio retrying a delivery; one it gives up
  on is lost, as with any webhook. The calendar's reminders are made at startup
  as in 2c.

## 14. Testing

- The rating, against a table: tags (read-only, destructive, both missing) ×
  audience × fixed list × outsider turn, with the expected outcome of each row.
  The fixed list and the destructive check each get their own table of slugs that
  must and must not match.
- Verifying: a good signature, a bad one, an old timestamp, a repeat.
- Each trigger's mapping to the common event, against recorded payloads, captured
  with `scripts/capture-2e.ts <account>`.
- The reviewer behind the model interface: the pipeline is tested with a fake, and
  a small labelled set of writes scores its prompt whenever it changes.
- The Composio write ask, end to end with a fake Composio and the fake chat
  adapter: yes runs exactly what was shown, no declines, other text reaches the
  main session.
- `&composio undo` for a create and for an update.
- The calendar's rules of parent section 7, against a fake Composio calendar.
- The configuration: old source keys refused, a missing `.env` key named.

## 15. Done when

- A Linear issue, a Notion comment, a Stripe test-mode failed payment and a
  calendar reminder each reach the Clot through Composio, routed and triaged as
  before.
- In a team account the Clot creates a Linear issue without asking, and it is
  posted with its undo; `&composio undo` archives it.
- A destructive write in a team account goes to the reviewer, and one it returns
  as `ask` is answered in `<clot>-ask`.
- A write in a public account asks.
- The Clot adds, moves and removes a calendar event through Composio under the
  existing rules, and `&calendar undo` reverses each.
- A trigger disabled by hand is noticed and recreated by the daily check.

## 16. Checked live before building

Each of these was checked live with `scripts/spike-2e.ts`, against the Clots' own
Composio project, before anything was built on it:

1. Linear and Notion triggers on a connection made with an API key: Linear's
   polled private-team triggers work; every webhook trigger (Linear's public
   ones, all of Notion's) fails, since Composio registers a webhook only through an
   OAuth app. Sections 8 and 9 follow from this.
2. The Clots' Linear member does not need to register a webhook or be an admin:
   Composio registers none for a key connection.
3. Notion's ingress needs an OAuth app's client ID, so it is not used.
4. A restricted Stripe key needs read and write access to webhook endpoints for
   Composio's Stripe triggers: with read access only, Composio's call to list the
   endpoints answered 403.
5. Composio's tags are set on every tool of the five toolkits. A few tools that
   write carry `readOnlyHint` (`NOTION_CREATE_VIEW_QUERY`,
   `STRIPE_CREATE_REPORT_RUN`, PostHog's `CREATE_…_QUERY` tools), which is why
   section 11 does not trust that tag alone. Linear's delete, archive and remove
   tools carry only `updateHint`, so the destructive check also reads the slug.
6. Composio's calendar list returns expanded occurrences with their series' ID
   (`recurringEventId`) and original start; a deleted event reads back with
   `status: "cancelled"`, and deleting it again fails with a 410.

## 17. Not in 2e

- Moving GitHub or email to Composio.
- Composio's Notion triggers, and Linear's webhook triggers (each needs an OAuth
  app), and the two Stripe kinds Composio has no trigger for.
- Sentry and Vercel (Composio has no triggers for them; 2c section 16 stands).
- Composio's remote sandbox, and the computers some toolkits offer (Orgo, Browser
  Use): the Clots have their own (parent section 10).
- Giving workers Composio tools.
- Composio's own MCP server URL in the Clot's session: every call goes through the
  daemon's rating.
