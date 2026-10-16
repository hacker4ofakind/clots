# Clots stage 2c: more sources, recipes and routing

Date: 2026-10-14
Status: implemented, except Sentry, Vercel and PostHog (section 16), which are built later.
Parent design: `.superpowers/specs/2026-10-10-clots-design.md`. This document
specifies the third of the four parts of stage 2 (section 16 there). It builds on
stage 2a (`.superpowers/specs/2026-10-11-clots-stage-2a-pipeline-design.md`), stage
2b (`.superpowers/specs/2026-10-12-clots-stage-2b-rulebook-design.md`) and global
memory (`.superpowers/specs/2026-10-14-clots-global-memory-design.md`). Plan:
`.superpowers/plans/2026-10-14-clots-stage-2c-sources.md`.

## 1. What 2c delivers

Events reach the Clots from Stripe, email, Google Calendar, Linear and Notion, as
GitHub's do in 2a. Each is verified, stored, pre-filtered, routed, held when
automated, triaged and investigated under the lock, through the pipeline that
already exists.

A Clot can save a reply as a draft in the user's mailbox, read the user's
schedule, add or move an event in the user's calendar, and remove one after two
yeses from the user.

Two kinds of recipe let a service with no built-in support reach the Clots without
new code: a watch recipe, in which the daemon calls a read-only tool of an MCP
server on a timer and reports what is new; and a webhook recipe, which describes
how to verify and read a service's webhook.

A source can serve several projects. Its events are routed by rules, then by a
routing call, then to the home Clot; the user corrects a wrong routing in chat.

Standing rules gain three ways of sending: an email reply, a Linear comment and a
Notion comment.

Sentry, Vercel and PostHog are specified here in full. Their tasks in the plan are
marked not required immediately: they are built once the user has a project that
uses them, so that they can be checked live.

## 2. Where 2c sits in the parent design

2c builds these parts of the parent design, and is where each is specified in
full:

- **The remaining sources** (parent section 9): Stripe, email, Google Calendar,
  Sentry, Vercel and PostHog, and with them Linear and Notion as built-in sources.
- **Watch recipes** (parent section 9), with the daemon as an MCP client that can
  log in to a server through OAuth.
- **Webhook recipes**, which the parent design did not have: the declarative
  counterpart of a watch recipe, for services that send webhooks.
- **Shared sources, routing rules, the routing call and routing corrections**
  (parent sections 3 and 5).
- **Each source's way of sending** for standing rules (parent section 5).
- **Email drafts and the calendar tools** (parent section 7): the first daemon
  tools that act in the user's own accounts.

## 3. Live now, and later

| Source | Built and checked live in 2c | Not required immediately |
|---|---|---|
| Stripe | yes | |
| Email (Gmail and any IMAP server) | yes | |
| Google Calendar | yes | |
| Linear | yes | |
| Notion | yes | |
| Watch recipes and the MCP client | yes, against Notion's hosted MCP server | |
| Webhook recipes | yes, against Linear in a second workspace | |
| Sentry | | specified in section 16 |
| Vercel | | specified in section 16 |
| PostHog | | specified in section 16 |

The plan's tasks for the last three are marked **not required immediately**. 2c is
merged without them; they are built when the user can check them against a real
project.

## 4. The common event

The event of 2a gains two fields and renames one:

| Field | Meaning |
|---|---|
| `id` | Unique. GitHub's delivery ID as before; for every other source, the source's name, the account and the source's own ID (section 6). |
| `source` | `github`, `stripe`, `email`, `calendar`, `linear`, `notion`, `sentry`, `vercel`, `posthog`, or a recipe's name |
| `account` | Which configured account of the source it came from (section 5). For GitHub, `github`. For a recipe, the recipe's name. |
| `kind` | What happened (below) |
| `place` | Where at the source it happened: `owner/name` for GitHub, the team key for Linear, the parent page or database for Notion, the address mail was sent to, the calendar, the Stripe account. Compared without regard to case. It replaces `repo`. |
| `actor` | Who caused it |
| `title` | One line: what happened |
| `body` | The relevant text, trimmed to a fixed length |
| `url` | A link to the thing at the source, or empty when the source has none |
| `ref` | The source's name for the thing: an issue number, a Message-ID, a Stripe object ID |
| `subject` | What the event is about. Automated events about one subject are held together. |
| `automated` | Whether a machine produced it |
| `receivedAt` | When the daemon received it |

The kinds each source produces:

| Source | Kinds |
|---|---|
| GitHub | `issue_opened`, `comment`, `review`, `pr_opened`, `ci_failed` |
| Linear | `issue_opened`, `comment` |
| Notion | `page_created`, `comment` |
| Stripe | `payment_failed`, `dispute_opened`, `subscription_canceled`, `fraud_warning`, `payout_failed`, `refunded`, `invoice_overdue`, `checkout_completed` |
| Email | `email` |
| Calendar | `reminder` |
| A watch recipe | `item_added`, `item_changed` |
| A webhook recipe | the kinds it declares (section 15) |
| Sentry | `error_alert`, `error_new` |
| Vercel | `deploy_failed` |
| PostHog | `analytics_event` |

Sources share a kind where it means the same thing: an issue opened on GitHub and
on Linear are both `issue_opened`, told apart by `source`. `batch` is still made
only by the daemon.

The block the Clot and triage see (2a section 6) gains the event's `id`, `account`
and `place` in place of `repo`. The Clot names an event by that ID when it calls a
tool about it.

### Rules name the new fields

A pre-filter, a standing rule's trigger and a routing rule match on any of
`source`, `account`, `kind`, `place`, `actor` and `titleContains`. `repo` is still
accepted and means `source: github` with that `place`, so the rule files of 2a and
2b keep working. When a rule names a built-in source and a kind, the kind must be
one that source produces; a rule that names no source may name any kind but
`batch`.

## 5. Configuration

`clots.config.json` gains three keys:

```json
{
  "publicUrl": "https://laptop-nj7mbno6.tailf707aa.ts.net",
  "clots": [{ "name": "encryptify", "repoUrl": "…", "about": "Encryptify: a web app that encrypts files in the browser" }],
  "sources": {
    "stripe": [{ "account": "encryptify", "clot": "encryptify", "webhookSecret": "STRIPE_ENCRYPTIFY_WEBHOOK_SECRET", "apiKey": "STRIPE_ENCRYPTIFY_KEY" }],
    "email": [{ "account": "gmail", "shared": true, "address": "someone@gmail.com", "password": "EMAIL_GMAIL_PASSWORD", "mailboxes": ["Clots"] }],
    "calendar": [{ "account": "personal", "shared": true, "icalUrl": "CALENDAR_PERSONAL_ICAL", "script": "CALENDAR_PERSONAL_SCRIPT", "scriptSecret": "CALENDAR_PERSONAL_SCRIPT_SECRET" }],
    "linear": [{ "account": "tady", "shared": true, "webhookSecret": "LINEAR_TADY_WEBHOOK_SECRET", "apiKey": "LINEAR_TADY_KEY" }],
    "notion": [{ "account": "tady", "shared": true, "token": "NOTION_TADY_TOKEN" }]
  },
  "mcpServers": {
    "notion": { "url": "https://mcp.notion.com/mcp", "oauth": true }
  }
}
```

- **`publicUrl`**: the address the tunnel gives the intake port. The daemon uses it
  for the OAuth callback and to tell the user the address of each webhook.
- **`about`**: one line per Clot, for the routing call (section 7). Optional; a
  Clot without one is described by its repository's name.
- **`sources`**: a list of accounts per source. Every account has a name of its own
  within the source (`account`), and either `clot`, the Clot it is bound to, or
  `shared: true`. A value that is a credential is never written in this file: the
  file names the key in `.env` that holds it.
- **`mcpServers`**: the daemon's own MCP servers (section 13).

GitHub keeps its configuration: a repository is bound to the Clot whose `repoUrl`
names it, and the home Clot takes the rest (2b section 9).

The fields each source's account takes are listed in its section. An account name
uses lowercase letters, digits and hyphens.

## 6. Intake

### Webhooks

The intake server answers on one path per source account:

| Path | For |
|---|---|
| `/webhooks/github` | GitHub, as in 2a |
| `/webhooks/stripe/<account>` | a Stripe account |
| `/webhooks/linear/<account>` | a Linear workspace |
| `/webhooks/notion/<account>` | a Notion workspace |
| `/webhooks/sentry/<account>`, `/webhooks/vercel/<account>`, `/webhooks/posthog/<account>` | section 16 |
| `/webhooks/r/<recipe>` | a webhook recipe (section 15) |
| `/oauth/callback` | the end of an OAuth login (section 13) |

Each path verifies the request the way its source signs it, and refuses one that
fails. What follows is as in 2a: a delivery whose ID is already stored is
acknowledged and ignored, a new one is stored, the source is answered, and only
then does the pipeline take it. A delivery of a type the Clots do not react to is
acknowledged and discarded. An unknown path is answered with 404. Every request that
is not stored (refused, ignored, a repeat, an unknown path) leaves a line in the
daemon's log, so a source that seems silent can be told apart from one refused. A
line in chat about an event ends in its link only when the source gives one.

### Listeners and pollers

Email, the calendar and watch recipes are not pushed to the daemon; it fetches
them. Each makes an event ID from what the source gives it:

| Source | Event ID |
|---|---|
| Email | `email:<account>:<Message-ID>` |
| Calendar | `calendar:<account>:<event UID>:<occurrence start>:<lead time>` |
| A watch recipe | `<recipe>:<item ID>:<hash of the item>` |

So a message, a reminder or an item that is seen twice is dropped as a repeat,
exactly as a GitHub delivery is. Each listener stores how far it has read (an IMAP
UID, a recipe's last result) and continues from there after a restart.

Every listener runs on its own. One that fails is retried with a growing wait, up
to an hour. After three failures in a row the user is told once, in the channel of
the Clot the account is bound to, or in every Clot's channel for a shared account;
and told again when it works.

### The webhook secrets

A webhook's secret is read from `.env` at startup. A webhook recipe's secret is
read again whenever the rulebook is reloaded (section 15).

## 7. Routing

### The order

1. **Self-caused drop** (each source's rule is in its section).
2. **Enrichment** (each source's is in its section). It comes before the rules,
   which match on the title and the actor: a Notion delivery names neither until
   its page is read. What is read is stored with the event and done once.
3. **Global pre-filters**, from `global.yaml`. They are checked before routing, so
   an event they drop costs no routing call.
4. **Route:**
   - an account bound to a Clot sends its events to that Clot;
   - a GitHub repository is routed as in 2b;
   - an event from a shared account is checked against the routing rules, and the
     first that matches names the Clot;
   - an event no rule matches goes to the routing call;
   - when the routing call is not confident, or fails, the event goes to the home
     Clot. Without a home Clot it is logged and dropped.
5. **The Clot's own pre-filters**, from its own file.
6. From here the pipeline of 2a: hold, triage, steering question, queue,
   investigation. Automated events are held in groups by Clot, `place` and
   `subject`; for GitHub that is the repository and subject of 2b.

### Routing rules

A list under `routing` in `global.yaml`, and only there: routing decides between
Clots, so it belongs to the file they share.

```yaml
routing:
  - source: email
    place: nicholas+encryptify@tady.ch
    clot: encryptify
  - source: calendar
    titleContains: encryptify
    clot: encryptify
  - source: linear
    place: ENC
    clot: encryptify
```

- A rule matches as a pre-filter does (section 4) and names at least one field to
  match on. `clot` is a project Clot's name or `home`.
- A rule naming a Clot that does not exist is ignored, and the user is told as for
  an invalid file (2a section 9).
- Rules apply only to events from shared accounts. A bound account's events are
  never routed elsewhere.
- Email aliases are routing rules. An account can have any number.

### The routing call

One Sonnet 5.5 call at low effort, no tools, with a fixed output schema, like
triage. It sees the event, the global triage guidance, and the list of Clots: each
name with its `about` line, and the home Clot described as "anything that belongs
to no project". It answers with one Clot's name, or none, and whether it is
confident. Its system prompt treats the event as data, as triage's does.

It runs only for events from shared accounts that no rule routed.

### Correcting a routing

The user says in a Clot's channel that an event belongs elsewhere ("that was for
graphite"). The Clot calls `route_correct` with the event's ID and the right Clot.

- The daemon checks that the event was routed to this Clot and that the target is
  another Clot that exists, the home Clot included.
- The event is handed over: its Clot is changed, a line in each channel says it
  moved, and it joins the other Clot's queue as an event of its own, with the
  one-line message triage wrote. Triage does not run again.
- Allowed in a working turn only. Under the lock it is refused.
- When the correction shows a pattern (every mail to one alias, every event with a
  word in its title), the Clot proposes a routing rule with `rulebook_routing`.
  Every edit to `global.yaml` is a proposal (2b section 5), so this one is too.
- A batch moves as a whole.

## 8. Stripe

Each of the user's apps has its own Stripe business, so each Stripe account is
bound to one Clot.

**Account fields:** `account`, `clot` or `shared`, `webhookSecret` (the `.env` key
of the endpoint's signing secret, `whsec_…`), `apiKey` (the `.env` key of a
restricted key), and `checkoutCompleted` (default `false`).

**Setup:** in the Stripe dashboard, an endpoint at
`<publicUrl>/webhooks/stripe/<account>` listening to the events below, and a
restricted key with read access to customers, charges, disputes, invoices,
payouts, products, prices, refunds and subscriptions.

**Verifying:** `Stripe-Signature`, as Stripe documents it: the header holds a
timestamp `t` and one or more signatures `v1`, each an HMAC-SHA256 in hex of the
timestamp, a dot and the raw body, with the endpoint's secret. One must match, in
constant time, and the timestamp must be within five minutes of the daemon's clock.
No Stripe library is needed: verification is these few lines, and the reads below
are plain HTTPS requests.

**Kinds:**

| Kind | Stripe event |
|---|---|
| `payment_failed` | `invoice.payment_failed`, `payment_intent.payment_failed` |
| `dispute_opened` | `charge.dispute.created` |
| `subscription_canceled` | `customer.subscription.deleted` |
| `fraud_warning` | `radar.early_fraud_warning.created` |
| `payout_failed` | `payout.failed` |
| `refunded` | `charge.refunded` |
| `invoice_overdue` | `invoice.overdue` (Stripe sends it only when overdue reminders are on in its Billing settings) |
| `checkout_completed` | `checkout.session.completed`, only when `checkoutCompleted` is `true` |

**The event:**

- `id` is `stripe:<account>:<evt_…>`; `place` is the account; `ref` is the object's
  ID.
- `actor` is the customer's email address, or `stripe` when the object has no
  customer.
- `title` says what happened, the amount and the customer, for example "Payment of
  €12.00 failed for jane@example.com (card declined)"; and "(test mode)" when the
  event is not live.
- `url` is the object in the Stripe dashboard.
- `subject` is `customer:<cus_…>` when the object has a customer, otherwise the
  object itself (`payout:<po_…>`).
- Every Stripe event is automated, so events about one customer within the hold's
  window (a failed payment, then the cancellation it caused) arrive as one batch.

**Enrichment:** before the rules and routing (section 7) the daemon reads, with the restricted key, what the
delivery leaves out: the customer's name and email, the invoice's lines with their
products, the failure or refund reason, a dispute's reason and the date evidence is
due. If the reads fail, the event goes on with a line saying so.

**Self-caused:** none. The Clots never write to Stripe, and standing rules have no
way of sending to it.

## 9. Email

**Account fields:** `account`, `clot` or `shared`, `address` (the account's own
address), `addresses` (other addresses the account receives for, such as
`support@…` delivered into it; optional), `password` (the `.env` key), `imap` and
`smtp` (host and port; Gmail's are the defaults when the address ends in
`@gmail.com`), and `mailboxes` (the folders or Gmail labels the daemon watches).

**Setup:** for Gmail, 2-step verification and an app password; a Gmail filter that
puts the right mail under a label, or mail sent to `+aliases`; and each alias that
standing replies should come from added under Settings → Accounts → "Send mail as"
(Gmail rewrites any other sender to the account's own address). For another server,
the account's password and the server's addresses.

### Intake

- One IMAP connection per watched mailbox, in IDLE, through `imapflow`. IDLE is
  restarted every ten minutes, well before Gmail closes it at about 29.
- Nothing outside the listed mailboxes is read. Messages are fetched without being
  marked as read; the daemon changes nothing in the mailbox when it reads.
- For each mailbox the daemon stores its UIDVALIDITY and the highest UID it has
  handled. On connecting it fetches every message above that UID, so mail that
  arrives while the daemon is down is picked up. The first connection to a mailbox,
  and one whose UIDVALIDITY has changed, only records where the mailbox is: mail
  already there is not reported.
- Messages are parsed with `mailparser`. A message larger than 5 MB is reported
  with its headers only.

### The event

- `id` is `email:<account>:<Message-ID>`; a message without a Message-ID uses the
  mailbox, UIDVALIDITY and UID instead.
- `actor` is the sender's address; `title` is the subject.
- `place` is the first recipient (`Delivered-To`, then `To`, then `Cc`) that is the
  account's address, a `+alias` of it, or one of its `addresses`; otherwise the
  account's address.
- `body`: the sender's name and address, the recipients, the date, the plain text
  (converted from HTML when there is no plain part) with the quoted earlier
  messages removed, and the name, type and size of each attachment. Attachments are
  not read.
- `subject` is `thread:<first Message-ID in References>`, or the message's own
  Message-ID when it starts a thread.
- `ref` is the Message-ID.
- `url`: on Gmail, a link to the thread in Gmail's web view, from the thread ID
  Gmail gives over IMAP. Other servers have none.
- `automated` when the message has `List-Id`, `Auto-Submitted` other than `no`, or
  `Precedence: bulk` or `list`.

**Self-caused:** a message whose Message-ID the daemon itself sent (section 17) or
saved as a draft.

### Drafts

`email_draft` saves a message in the account's Drafts folder (the mailbox IMAP marks
`\Drafts`; Gmail's `[Gmail]/Drafts`) for the user to read, change and send from
their mail client.

- It takes the text and either the ID of an email event it answers, or an account,
  recipients and a subject for a new message.
- A reply is addressed to the sender (its `Reply-To` when there is one), its
  subject starts with "Re:", it carries `In-Reply-To` and `References`, and it is
  from the address the original was sent to.
- A new message is from the account's address.
- Plain text only. The daemon posts the draft in the Clot's live channel.
- Allowed in a working turn only. Under the lock it is refused: an investigation
  writes its draft in its reply, and the user's go-ahead lets the next turn save
  it.
- Nothing is sent. Sending stays the user's, as the parent design says.

### Standing replies

A standing rule with `via: email_reply` sends its template over SMTP, through
`nodemailer`, as a reply to the email event that triggered it: to the sender, in
the thread, from the address the original was sent to. This is the one place a
Clot sends as the user: a template the user approved word for word, sent from the
address the mail came to. Section 17 has the rules every way of sending shares.

## 10. Google Calendar

The daemon reads and writes the user's calendar with nothing but the user's own
Google account: no Google Cloud project and no OAuth client.

**Account fields:** `account`, `clot` or `shared`, `icalUrl` (the `.env` key of the
calendar's secret address in iCal format), `script` and `scriptSecret` (the `.env`
keys of the Apps Script's address and secret; optional, and without them the
calendar is read-only), `leadTimes` (default `["24h"]`), and `pollMinutes`
(default 5).

**Setup:** in Google Calendar, the calendar's settings, "Secret address in iCal
format". For writing: a new project on script.google.com, the script that ships
with Clots (`setup/calendar.gs`) pasted in, a secret set in its script properties,
and a deployment as a web app that runs as the user, reachable by anyone with the
address. Google asks the user once to allow their own script.

### Reading

- The daemon fetches the iCal feed every `pollMinutes`, parses it with `ical.js`,
  and expands repeating events, their exceptions and their moved occurrences. A
  cancelled occurrence is skipped.
- The time zone is the configuration's `timeZone`. An all-day event starts at
  midnight in that zone.

### Reminders

For each occurrence and each lead time, a `reminder` event when the time before
the start is within the lead time:

- `id` is `calendar:<account>:<UID>:<occurrence start>:<lead time>`, so each
  reminder is made once. An occurrence that moves gets reminders for its new time.
- `title`: the event's title and when it starts, for example "Demo with ACME
  tomorrow at 14:00".
- `body`: the time range, the location, the organiser, how many guests and who,
  the description, and the links found in the description and location.
- `actor` is the organiser, or the account's address. `place` is the account.
  `subject` is `event:<UID>`. Not automated.
- A reminder that came due while the daemon was down is made at startup if the
  occurrence has not started yet. One whose occurrence has started is not made.
- Routed by routing rules (usually on `titleContains`), then the routing call, then
  the home Clot.

Calendar descriptions and titles can be written by other people (an invitation),
so a reminder is untrusted data like any event.

### `calendar_list`

Returns the occurrences in a range, at most 31 days, from every calendar account:
title, start and end, location, the start of the description, and the event's ID.
It reads the last fetched feed, fetching again if it is older than `pollMinutes`.
It only reads, so it is approved under the lock.

### `calendar_write`

Creates an event, or changes one: its time, title, description or location.
Through the Apps Script; refused for a calendar without one.

- The daemon posts each change in the Clot's live channel, with the event as it was
  and as it is.
- The script refuses an event that has guests, and never adds one: nothing the
  Clots do in the calendar notifies another person.
- A repeating event without guests can be changed, and the change applies to the
  whole series: Apps Script fetches an event by its iCal UID as the series. Only
  guests make an event the user's alone to change, since a mistake would reach them.
- Allowed in a working turn only. Under the lock it is refused.

### `calendar_remove`

Removes one event. Two yeses are needed:

1. **In chat.** The Clot's system prompt tells it to ask the user in chat, naming
   the event, and to call the tool only after the user has said yes. The daemon
   cannot check this; it allows the tool only in a working turn the user started
   with no steered event in it (2b section 5), the turn in which that yes can have
   been given.
2. **In a temporary channel.** The daemon puts the removal to the user as it puts a
   rule proposal (2b section 6): a channel named `<clot>-cal`, then
   `<clot>-cal-2`, the event shown exactly (calendar, title, time, location, the
   start of the description), the same accepted replies, and every rule of a
   proposal: the tool returns at once, the reply never reaches the model, the
   outcome is posted in the live channel and left as a note for the Clot, it lasts
   as long as the session, it counts towards the limit on open proposals, it
   survives a restart, and an answer stands.

On yes the script checks again that the event exists and has no guests, then
deletes it; a repeating event is removed as a series. The removal is posted in the
live channel.

### The script

`setup/calendar.gs` is a few dozen lines of Apps Script. It answers a POST whose
JSON body holds the secret and one action: `create`, `update` or `remove`. Apps
Script does not show a request's headers to the script, so the secret travels in
the body; the request goes over HTTPS. It finds an event by its iCal UID, refuses
what section 10 refuses, and answers with JSON: the event as it now is, or the
reason for a refusal.

## 11. Linear

**Account fields:** `account`, `clot` or `shared`, `webhookSecret` and `apiKey`
(`.env` keys).

**Setup:**

- The Clots get a member of their own in each Linear workspace, as on GitHub: an
  account the user creates and invites. Its personal API key is `apiKey`.
- A workspace admin adds a webhook at `<publicUrl>/webhooks/linear/<account>` for
  issues and comments, and puts its signing secret in `.env`.

**Verifying:** `Linear-Signature`, an HMAC-SHA256 of the raw body in hex, compared
in constant time. A delivery whose `webhookTimestamp` is more than a minute from
the daemon's clock is refused. The delivery ID is the `Linear-Delivery` header.

**Kinds:** an issue created is `issue_opened`; a comment created is `comment`.
Updates and removals are discarded.

**The event:**

- `id` is `linear:<account>:<delivery ID>`; `place` is the team's key; `ref` is
  the issue's identifier (`ENC-12`); `subject` is `issue:ENC-12`.
- `actor` is the actor's name. An actor that is an integration or an application
  makes the event automated.
- `url` is the issue or the comment.

**Enrichment:** with the Clots' key, the issue's title, description, state,
priority, labels, assignee and its last ten comments. If the read fails, the event
goes on with a line saying so.

**Self-caused:** the actor is the Clots' member, whose ID the daemon reads from the
key at startup. That drops a standing comment's own event.

**Sending:** `via: linear_comment` comments on the issue the event is about, as
the Clots' member.

## 12. Notion

**Account fields:** `account`, `clot` or `shared`, `token` (the `.env` key of the
internal integration's secret), and `verificationToken` (the `.env` key of the
webhook's verification token; optional, section "The handshake" below).

**Setup:** an internal integration with the capabilities to read content, read
comments and insert comments; the pages and databases the Clots should see shared
with it; and in the integration's Webhooks tab a subscription at
`<publicUrl>/webhooks/notion/<account>` for `page.created` and `comment.created`.

### The handshake

When the subscription is created, and whenever the user asks Notion to resend it,
Notion sends a request whose body holds a `verification_token` and no event. Notion
may sign it, but the signature cannot be checked: the token is its key. So a request
with a `verification_token` and no `type` is the handshake, signed or not.

- When the account has no token yet, the daemon stores it and prints it in its log,
  with the account's name. The user copies it from there into Notion to finish the
  subscription. It never passes through chat.
- When the account already has one, the request is logged and ignored, so nobody
  can replace a token by sending a request of their own.
- A token in `.env` (`verificationToken`) takes precedence over the stored one. It
  is how the user replaces a token: by setting it, or by deleting the subscription
  and clearing the stored token with the daemon stopped.

### Verifying

`X-Notion-Signature`, `sha256=` followed by an HMAC-SHA256 of the raw body in hex,
with the verification token as the key, compared in constant time.

**Kinds:** `page.created` is `page_created`; `comment.created` is `comment`. Other
event types are discarded.

**The event:**

- `id` is `notion:<account>:<event ID>`; `subject` is `page:<page ID>`; `ref` is
  the page's ID.
- `place` is the ID of the page's parent page or database. The body names its
  title.
- `actor` is the author. The delivery names the author by ID only, so the
  enrichment below puts the author's name in its place when it can read it. A bot
  as the author makes the event automated.
- `url` is the page.

**Enrichment:** Notion's events say only that something happened. Before the rules
and routing (section 7) the daemon reads, with the integration's token, the page's
title, which becomes the event's title, its properties as text and the first 2,000
characters of its content, and for a comment its text and the discussion it belongs
to; and the author's name. So a routing rule on `titleContains` works for Notion. If the read fails, the event goes on with a line
saying so.

**Self-caused:** the author is the integration's own bot user, whose ID the daemon
reads at startup.

**Sending:** `via: notion_comment` adds a comment to the page the event is about,
as the integration.

Notion gathers changes before it sends them, so an event can arrive a minute or so
after the change.

## 13. The daemon's MCP client

The daemon connects to MCP servers of its own, set in `mcpServers`, with the
official TypeScript SDK. The Clots' containers have their own connectors through
their Claude login (parent section 10); those are out of the daemon's reach.

### Servers

```json
"mcpServers": {
  "notion": { "url": "https://mcp.notion.com/mcp", "oauth": true },
  "tracker": { "url": "https://example.com/mcp", "headers": { "Authorization": "TRACKER_MCP_AUTH" } },
  "local-thing": { "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "API_KEY": "LOCAL_THING_KEY" } }
}
```

- A server is started by a command (stdio) or reached at a URL (Streamable HTTP).
- `headers` and `env` map a name to the `.env` key that holds its value.
- `oauth: true` logs in with OAuth (below).
- The daemon connects to each server at startup and keeps the connection, and
  connects again when it drops, as any listener (section 6).
- A stdio server runs on the daemon's host. It is the user's own configuration, as
  trusted as the daemon.

### OAuth

- The daemon registers itself with the server's authorization server (dynamic
  client registration) and stores what it is given.
- When the server needs a login, the daemon posts a link in the channel of each
  Clot that has a recipe on that server. When none has, it posts in the home
  Clot's channel, or in every Clot's channel when there is no home Clot. The link is valid for ten minutes and can be
  used once: its `state` is random and checked on return, and the code verifier
  (PKCE) never leaves the daemon.
- The login returns to `<publicUrl>/oauth/callback`. The daemon exchanges the code,
  stores the tokens in its database, answers the browser with "Logged in. You can
  close this tab.", and posts that the server is connected.
- Tokens are refreshed when they expire. If a refresh fails, the server's recipes
  pause and a new link is posted, at most once an hour until the user logs in.
- A callback with an unknown or expired `state` is refused.

### `mcp_list`

A daemon tool that lists each server, whether it is connected, needs a login or
is failing, and its tools: name, description, and whether the tool declares itself
read-only. Descriptions come from the server and are wrapped as untrusted data. It
only reads, so it is approved under the lock.

When a server appears in the configuration that the daemon has not seen before, it
leaves a note for the home Clot, or for every Clot when there is none: the server's
name and that a watch recipe can be proposed for it. A note starts no turn
(2b section 6).

## 14. Watch recipes

A watch recipe calls one read-only tool on one of the daemon's MCP servers on a
timer, and reports the items that are new since the last call. No model is
involved.

```yaml
watches:
  - name: notion-feedback
    server: notion
    tool: notion-search
    arguments: { query: "Feedback" }
    items: results
    id: id
    title: "{title}"
    url: "{url}"
    every: 5
    report: added
```

| Field | Meaning |
|---|---|
| `name` | Lowercase letters, digits and hyphens; not a built-in source's name; unique across the rulebook. It is the events' `source` and `account`. |
| `server`, `tool`, `arguments` | What to call. |
| `items` | Where the list of items is in the result: a path of field names and indexes, such as `results` or `data.0.rows`; empty when the result is the list. |
| `id` | The path, within an item, of what identifies it. |
| `title`, `body`, `url`, `actor` | Optional. Text with `{path}` replaced by the value at that path in the item. Without a title, the item's ID is used; without a body, the item as JSON. |
| `ignore` | Optional. Paths left out when deciding whether an item changed, such as a last-viewed time. |
| `every` | Minutes between calls. Default 5, at least 1. |
| `report` | `added` (default) or `added_and_changed`. |
| `notReadOnly` | Must be `true` for a tool that does not declare itself read-only. See below. |

### How it runs

- The result is the tool's structured content when it has one, otherwise its text
  read as JSON. A result that is neither is a failure of the recipe.
- The first successful call records the items and reports nothing.
- Each later call compares by `id`: an item not seen before is `item_added`; with
  `added_and_changed`, an item whose content (less `ignore`) changed is
  `item_changed`. Items that went away are not reported.
- An item's event has `id` `<recipe>:<item ID>:<hash>`, `place` the server's name,
  `subject` `<recipe>`, and is automated: several new items at once arrive as one
  batch.
- At most 500 items are compared per call. Beyond that the rest are left out and
  the user is told once.
- A failing call is retried with a growing wait, and reported, as any listener
  (section 6). A recipe whose server needs a login waits for it.

### Where a recipe lives, and who adds it

- In a Clot's own file, its events go to that Clot. In `global.yaml`, they are
  routed (section 7).
- Adding, replacing or removing a recipe is always a proposal, through the
  `rulebook_watch` tool. Recipes written by hand take effect when the file is
  reloaded.

### Read-only

The daemon calls only the tool a recipe names, with the arguments it names. The
tool must declare itself read-only (MCP's `readOnlyHint`). A recipe for one that
does not must say `notReadOnly: true`; the proposal shows that line in bold with a
warning that the daemon will call a tool that may change something every few
minutes, and the user's yes covers it. A recipe without that line, for a tool that
does not declare itself read-only, is not run, and the user is told.

### `watch_try`

A daemon tool that runs a draft recipe once and returns how many items it found
and the first five as the recipe reads them, so the Clot can check a recipe before
proposing it. It refuses a tool that does not declare itself read-only. It changes
nothing and records nothing, so it is approved under the lock.

## 15. Webhook recipes

A webhook recipe describes, without code, how to verify and read the webhook of a
service the Clots have no built-in support for.

```yaml
webhooks:
  - name: linear-second
    verify:
      scheme: hmac-sha256
      header: Linear-Signature
      encoding: hex
      signed: body
      secret: RECIPE_LINEAR_SECOND
    delivery: { header: Linear-Delivery }
    kinds:
      - kind: issue_opened
        when: { type: Issue, action: create }
      - kind: comment
        when: { type: Comment, action: create }
    event:
      actor: "{actor.name}"
      title: "{data.title}"
      body: "{data.description}{data.body}"
      url: "{url}"
      ref: "{data.identifier}"
      place: "{data.team.key}"
      subject: "issue:{data.identifier}{data.issue.identifier}"
    automatedWhen: { actor.type: integration }
```

### Verifying

| Field | Meaning |
|---|---|
| `scheme` | `hmac-sha256`, or `token`: the header holds the secret itself (for services that cannot sign) |
| `header` | The header that holds the signature or the token |
| `prefix` | Text before the signature in the header, such as `sha256=` (optional) |
| `encoding` | `hex` or `base64` |
| `signed` | `body`, or `timestamp.body`: the timestamp, a dot, then the body |
| `timestampHeader` | Where the timestamp is, when `signed` is `timestamp.body` |
| `toleranceSeconds` | How far the timestamp may be from the daemon's clock (default 300) |
| `secret` | The `.env` key of the secret. It must begin with `RECIPE_`, so a recipe cannot name another of the daemon's secrets. |

Comparisons are made in constant time. A recipe whose secret is not in `.env` is
not active: its path answers 404, and the user is told once. The daemon reads the
`RECIPE_` keys of `.env` again whenever the rulebook is reloaded, so a recipe added
from chat works once its secret is saved, without a restart.

### Reading

- **`delivery`**: where the delivery's ID is, a `header` or a `field`. Without
  one, the ID is a hash of the body. The event's `id` is `<recipe>:<delivery ID>`.
- **`kinds`**: tried in order; the first whose `when` fields all equal the
  payload's gives the kind. A payload no entry matches is acknowledged and
  discarded. A kind uses lowercase letters, digits and underscores, and is not
  `batch`.
- **`event`**: text with `{path}` replaced by the value at that path in the
  payload; a path that is missing gives nothing. `title` is required.
- **`automatedWhen`**: optional fields whose values make the event automated.

The event's `source` and `account` are the recipe's name.

### Where a recipe lives, and who adds it

As for watch recipes: in a Clot's own file its events go to that Clot; in
`global.yaml` they are routed. Adding, replacing or removing one is always a
proposal, through `rulebook_webhook`. A Clot can draft one from a sample payload or
the service's documentation the user pastes in chat. The proposal shows the
address the user gives the service (`<publicUrl>/webhooks/r/<name>`) and the
`.env` key the secret goes in; the user puts the secret there and sets up the
webhook themselves.

## 16. Not required immediately: Sentry, Vercel and PostHog

Built after 2c is merged, once the user has a project that uses each, so that it
can be checked live. Each fits the parts above without changing them.

### Sentry

- **Account fields:** `account`, `clot` or `shared`, `clientSecret` and `authToken`
  (`.env` keys).
- **Setup:** an internal integration in the Sentry organisation, its webhook at
  `<publicUrl>/webhooks/sentry/<account>`, issue alerts and the `issue` resource
  switched on, and an alert rule whose action sends to the integration.
- **Verifying:** `Sentry-Hook-Signature`, an HMAC-SHA256 of the raw body in hex
  with the client secret. The delivery ID is the `Request-ID` header.
- **Kinds:** `Sentry-Hook-Resource: event_alert` is `error_alert`; `issue` with
  action `created` is `error_new`. Everything else is discarded.
- **The event:** `place` is the Sentry project's slug, `subject` is
  `sentry:<issue ID>`, `url` is the issue, `actor` is `sentry`, automated.
- **Enrichment:** the issue's latest event, with its stack trace, tags and release,
  read with the auth token.
- **Sending:** `via: sentry_comment` comments on the issue, as the integration.
- **Self-caused:** a comment by the integration.

### Vercel

- **Account fields:** `account`, `clot` or `shared`, `webhookSecret` and `token`
  (`.env` keys).
- **Setup:** an account webhook (Vercel's Pro plan or above) at
  `<publicUrl>/webhooks/vercel/<account>` for `deployment.error`.
- **Verifying:** `x-vercel-signature`, an HMAC-SHA1 of the raw body in hex with the
  webhook's secret.
- **Kind:** `deploy_failed`.
- **The event:** when the deployment came from GitHub, `place` is the repository's
  `owner/name` and `subject` is its pull request (`pr:14`) or branch
  (`branch:main`), as a GitHub CI failure's would be. A failed deploy and the CI
  failure from the same push are then held together and arrive as one batch.
  Without Git metadata, `place` is the Vercel project and `subject` is
  `deploy:<ID>`. Automated.
- **Enrichment:** the last 100 lines of the build log, read with the token.
- **Routing:** an account bound to a Clot, or shared. A shared account's events
  whose `place` is a repository bound to a Clot go to that Clot, as GitHub's do.
- **Sending:** none.

### PostHog

- **Account fields:** `account`, `clot` or `shared`, `token` (the `.env` key of a
  secret the user makes up).
- **Setup:** a webhook destination in PostHog, at
  `<publicUrl>/webhooks/posthog/<account>`, with the secret in an
  `X-Clots-Token` header. PostHog does not sign its webhooks, so the token in the
  header is the check. The destination's filters decide which events are sent.
- **Kind:** `analytics_event`.
- **The event:** `place` is the PostHog project, `subject` is
  `posthog:<event name>`, `actor` is the person's distinct ID, automated; several
  of the same event at once arrive as one batch. The delivery ID is the event's
  UUID.
- **Sending:** none.

## 17. Standing rules across sources

The standing rules of 2b work for every source. A rule's `via` decides how it
sends, and it must fit the trigger's source:

| `via` | Source | Sends |
|---|---|---|
| `github_comment` | `github` | A comment on the issue or pull request (2b) |
| `email_reply` | `email` | A reply to the sender, in the thread, from the address the mail came to |
| `linear_comment` | `linear` | A comment on the issue, as the Clots' member |
| `notion_comment` | `notion` | A comment on the page, as the integration |
| `sentry_comment` | `sentry` | A comment on the issue, as the integration (section 16) |

- A trigger that names no source means `github`, as every rule written in 2b
  does. A rule whose `via` does not fit its trigger's source makes the file
  invalid.
- The template fields are `{actor}`, `{title}`, `{ref}`, `{place}` and `{url}`.
  `{repo}` is still accepted and means `{place}`.
- The checks of 2b section 7 apply to every way of sending, in the same order. One
  more applies to `email_reply`: the email must not be automated. A Clot never
  answers a mailing list or another program's mail, so two programs cannot answer
  each other for ever.
- Each way of sending records the send before it sends and keeps the record unless
  the source definitely refused, as in 2b. `email_reply` records the Message-ID it
  gives the reply, so the reply that comes back into a watched mailbox is dropped as
  self-caused.
- Mentions: only GitHub turns `@name` in plain text into a notification. In the
  other ways of sending, plain text mentions nobody, so the mention rule of 2b is
  GitHub's alone.

Stripe, the calendar, Vercel, PostHog and recipes have no way of sending.

## 18. Daemon tools and the lock

The tools 2c adds, and where they may run:

| Tool | Does | Working turn | Under the lock |
|---|---|---|---|
| `route_correct` | Hands an event to another Clot (section 7) | yes | refused |
| `rulebook_routing` | Adds or removes a routing rule | proposal | proposal |
| `email_draft` | Saves a draft (section 9) | yes | refused |
| `calendar_list` | Reads the schedule (section 10) | yes | yes |
| `calendar_write` | Creates or changes an event (section 10) | yes | refused |
| `calendar_remove` | Puts a removal to the user (section 10) | only in a turn the user started with no steered event | refused |
| `mcp_list` | Lists the MCP servers and their tools (section 13) | yes | yes |
| `watch_try` | Runs a draft watch recipe once (section 14) | yes | yes, read-only tools only |
| `rulebook_watch` | Adds, replaces or removes a watch recipe | proposal | proposal |
| `rulebook_webhook` | Adds, replaces or removes a webhook recipe | proposal | proposal |

The existing rulebook tools (2b section 4) gain the new fields of section 4 and the
lists `routing`, `watches` and `webhooks` in what `rulebook_show` returns.

The hook that is asked before every tool call in a locked turn (2a section 7)
approves the tools in the "yes" and "proposal" cells of the last column, and the
tool itself refuses the rest with the reason, so the Clot can say what it could not
do.

### The Clot's system prompt

It gains:

- the sources a Clot can hear from, and that every source's content, calendar
  invitations and email included, is untrusted data;
- the new tools, and that drafts, calendar changes and routing corrections happen
  in working turns;
- for `calendar_remove`: to ask the user in chat first, naming the event, and to
  call the tool only after the user's yes.

### Triage's prompt

It no longer assumes one software project. It describes the kinds of every source,
says that payments, email and reminders are as much the Clot's business as code,
and names email as the most common carrier of attempts to instruct the agent.

## 19. Components

| Component | Responsibility | Depends on |
|---|---|---|
| Intake (changed) | One path per source account and per webhook recipe, and the OAuth callback. Hands each request to its source's verifier and adapter. | Sources, store |
| Source adapters | One per source: verifies a request and turns it into the common event, or nothing. Pure, apart from the Notion handshake's stored token. | None |
| Enrichers | One per source that needs it: reads what a delivery leaves out (Stripe, Linear, Notion, GitHub reviews, Sentry, Vercel). | Each source's credentials |
| Email listener | IMAP IDLE per mailbox; catches up by UID; turns messages into events. | `imapflow`, `mailparser`, store |
| Calendar poller | Fetches and expands the feed; makes reminders; answers `calendar_list`. | `ical.js`, store |
| Calendar writer | Calls the Apps Script. | The script |
| MCP client | Connects to the daemon's servers; OAuth logins and tokens. | MCP SDK, store, chat |
| Watcher | Runs watch recipes on their timers; diffs; makes events. | MCP client, rulebook, store |
| Recipe reader | Verifies and reads a webhook recipe's deliveries. Pure. | None |
| Router | Routing rules, the routing call and the home Clot; `route_correct`. | Rulebook, routing call |
| Routing call | One Sonnet 5.5 call, low effort, no tools, fixed schema. | None |
| Senders (changed) | One per way of sending: GitHub, email, Linear, Notion, later Sentry. | Each source's credentials |
| Removals | Puts a calendar removal to the user, as a proposal. | Proposals, calendar writer |
| Rulebook (changed) | The new fields and lists; validates routing rules against the Clots, and `via` against triggers. | Rule files |
| Listener supervisor | Starts every listener, retries with a growing wait, reports failures and recovery. | Chat |
| Pipeline (changed) | Enrichment before the rules; global pre-filters before routing; routing; the Clot's own pre-filters; holding by Clot, place and subject. | Router, enrichers |
| Configuration (changed) | `publicUrl`, `about`, `sources`, `mcpServers`. | None |
| Daemon tools (changed) | The tools of section 18. | All of the above |

## 20. Failure handling

- **Daemon down:** webhook sources retry their deliveries (Stripe, Linear and
  Notion all do). Email is read from the last UID handled; reminders that came due
  are made if their event has not started; watch recipes call again at startup and
  compare against the last stored result.
- **A listener fails:** retried with a growing wait up to an hour; the user is told
  after three failures in a row, and when it recovers (section 6).
- **An enrichment read fails:** the event goes on with a line saying what could not
  be read.
- **The routing call fails:** the event goes to the home Clot, or is logged and
  dropped without one.
- **An OAuth refresh fails:** the server's recipes pause and the user gets a new
  login link (section 13).
- **The Apps Script refuses or cannot be reached:** the tool returns the reason and
  changes nothing; an approved removal that fails stays open, as an approved rule
  proposal does when the file cannot be written (2b section 6).
- **SMTP, Linear or Notion refuses a standing send:** as for GitHub in 2b: the tool
  returns the failure, and the record of the send is removed only on a definite
  refusal.
- **The IMAP server refuses the draft:** the tool returns the reason; the Clot
  gives the draft in its reply instead.
- **A rule file names a Clot, a source or a kind that does not fit:** the file is
  invalid or the rule is ignored, and the user is told once, as in 2a.

## 21. Testing

- **Unit tests:**
  - each source's verifier and adapter against recorded real deliveries, including
    refused signatures, stale timestamps and discarded types;
  - the Notion handshake, with and without a stored token;
  - email: parsing, quoted text removed, threads, bulk headers, the place chosen
    from the recipients, the catch-up by UID and a changed UIDVALIDITY;
  - the calendar: repeating events, exceptions, moved and cancelled occurrences,
    all-day events, reminders made once and after a restart;
  - routing: the order, rules against bound and shared accounts, the home Clot
    with and without one, the routing call's output parser;
  - watch recipes: paths, the baseline, added and changed items, `ignore`, the
    500-item limit, the read-only check;
  - webhook recipes: each verification scheme, kinds, `{path}` text, missing
    paths, a secret that is not set;
  - the OAuth state: unknown, expired and used `state`, and a failed refresh;
  - the rule files' new fields, `via` against the trigger, and `repo` still read;
  - the Apps Script's own checks, as plain functions.
- **Pipeline tests** with fakes for the IMAP server, the feed, the Apps Script, an
  MCP server and each source's API, and the stage 1, 2a and 2b fakes: every route,
  every tool of section 18 under each kind of turn, `calendar_remove` through to
  each reply, a routing correction, standing sends for each way of sending.
- A small labelled set of events from the new sources scores the triage prompt and
  the routing call.
- **Live checks** at the end, as in every stage. Sentry, Vercel and PostHog are
  tested with recorded deliveries only until their tasks are built.

## 22. Done when

In the development environment:

- `stripe trigger` for a failed payment and for a refund each reach the Clot the
  account is bound to; a failed payment followed by a cancelled subscription for
  the same customer arrives as one batch;
- mail to a routed alias, on Gmail and on the tady.ch server, is investigated by
  that alias's Clot; mail outside the watched mailboxes produces nothing;
- mail to an address no rule routes is routed by the routing call or goes to the
  home Clot; "that was for <clot>" moves it and the Clot proposes a routing rule;
- mail that arrives while the daemon is stopped is investigated after it starts;
- a draft reply appears in Gmail's Drafts, threaded with the original, and nothing
  is sent;
- a standing `email_reply` is sent once, in the thread, from the alias, and its
  copy coming back produces nothing; a newsletter does not trigger it;
- a calendar event 24 hours ahead produces one reminder in the right Clot;
  `calendar_list` answers from an investigation;
- `calendar_write` creates an event and moves it, renames a repeating event as a
  whole series, and refuses one with guests;
- `calendar_remove` after the user's yes in chat opens a `-cal` channel, and yes
  removes the event and no keeps it; under the lock it is refused;
- a Linear issue and a comment on it are investigated with the issue's
  description; a standing `linear_comment` is posted and its own event produces
  nothing;
- the Notion handshake completes with the token from the daemon's log; a new page
  in a shared database and a comment are investigated with their content; a
  standing `notion_comment` is posted and produces nothing on its way back;
- the daemon logs in to Notion's hosted MCP server through the link it posts; a
  watch recipe proposed by a Clot and approved reports nothing on its first run and
  one batch when new items appear;
- a webhook recipe for Linear in a second workspace, proposed and approved, turns a
  real issue into an event; a request with a bad signature is refused;
- the GitHub events of 2a and the rules of 2b still work unchanged.

## 23. Not in 2c

- Sending email beyond standing rules. A review channel in which a Clot asks to
  send an email and the user approves or gives feedback was discussed and set
  aside for later.
- Calendar events with guests, and changes to a single occurrence of a repeating
  event.
- Writing to Stripe.
- Credentials for Linear, Notion, Stripe or the calendar inside the Clots'
  containers: Clots see these sources through events and daemon tools only.
- Gmail through Google's API, Google's push notifications, and any Google Cloud
  project.
- Reading attachments.
- Gates, digests, the sweep and the spend log (2d).
- Entering secrets through the `clots` CLI (stage 3). Until then they go in `.env`.

## 24. Assumptions to verify first

- An Apps Script web app accepts a POST from the daemon, after the redirect Google
  answers with, and reads the secret from the JSON body; and it can find, change
  and delete an event by its iCal UID.
- Google's secret iCal address returns current events when fetched, without a
  delay of hours.
- IMAP IDLE works on the folder of a Gmail label, and Gmail gives a thread ID over
  IMAP from which a working web link can be made.
- Gmail's SMTP server keeps a `+alias` of the account's own address as the sender
  of a message once the alias is added under "Send mail as", so a standing reply
  comes from the alias the mail was sent to.
- Linear's free plan allows the Clots' member as a second member, and a webhook's
  `webhookTimestamp` is a time in milliseconds.
- Notion's hosted MCP server accepts dynamic client registration with the daemon's
  callback on the tunnel's address, and at least one of its read-only tools returns
  a result that can be read into items with IDs.
- Notion's handshake request reaches the daemon through the tunnel, and its
  signature check works on the raw body as described.
- Stripe test mode delivers `stripe trigger` events to an endpoint on the tunnel's
  address.

If any of these fails, stop and bring the finding to the user before continuing.
