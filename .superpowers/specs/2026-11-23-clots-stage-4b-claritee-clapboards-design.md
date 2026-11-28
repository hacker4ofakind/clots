# Clots stage 4b: Claritee and Clapboards

Date: 2026-11-23
Status: approved in brainstorming; not built. Builds on stage 4a.
Parent design: `.superpowers/specs/2026-10-10-clots-design.md`. First half of
stage 4: `.superpowers/specs/2026-11-23-clots-stage-4a-web-ui-design.md` (cited
as "4a section N"). Design system: https://claude.ai/artifact/C2iquQj5wikdWzjyFDaYmQ.

## 1. What stage 4b delivers

- **Claritee**, a small markup and script language for user interfaces, made to
  cost Clots as few tokens as possible. Clots write it in their replies, and
  the web app renders it as real, themed, interactive components.
- **Inline widgets**: a Claritee block inside a Clot's reply, for anything the
  user reads once to understand and moves on from: a comparison, a status, a
  short form asking for several things at once.
- **Clapboards**: single-page sites written in Claritee, for anything
  interactive, too big for a reply, or used or looked at more than once. A Clot
  publishes one and edits it live; it opens in the side pane on desktop and
  full screen on a phone.
- **The Clapboards skill**, not loaded by default, that teaches Clots how to make
  them well.

The name says the aim: replies a person can follow at a glance. Most replies
should use a widget where one makes them clearer.

## 2. Where it runs

| Piece | Where | What |
|---|---|---|
| `packages/claritee` | workspace package | lexer, parser, type inference, linter, the script interpreter, the component catalog's schema (names, attributes, children rules) |
| renderer | `web/components/claritee/` | the parsed tree to React, using the catalog's shadcn-based components |
| lint hook | daemon | checks every widget a main session writes, and every Clapboard save |
| Clapboard store | daemon | versions, `stored()` values, the API and stream events |
| skill | `plugin/skills/clapboards/` | copied into every Clot container |

The package has no DOM or Node dependencies, so the daemon lints with exactly
the parser the browser renders with.

## 3. The language

### 3.1 A first example

```claritee
counter = reactful(2);
Card px=8 fg=muted-foreground {
    H1 { Example Widget }
    Desc { Click the button. Current count: [counter] }
    Button click=counter++ { Click me }
}
```

### 3.2 Structure

- A block has a **script part** and a **markup part**, in any order at the top
  level. Script statements end with `;`. Markup never uses `;`.
- **Markup**: `Name attributes { children }`. Children are text, components and
  `[expressions]`, freely mixed. A component with no children may omit the
  braces (`Kbd { Ctrl }` needs them; `Progress value=40` does not).
- **Text** in children is literal. Inline markdown works inside it: `**bold**`,
  `*italic*`, `` `code` ``, `[label](https://…)`. Escape a literal `[`, `]`,
  `{` or `}` with `\`.
- **Telling markup from text**: inside children, a word starts a component only
  when it is a catalog name or a `comp` defined in the block, and is followed
  on the same line by attributes and `{`, or by `{` directly, or (for a
  component that takes no children) by attributes and the end of the line.
  Otherwise it is text: `Desc { Card payments failed. }` is one sentence.
- `[` followed by `](` later on the same line, as in `[label](https://…)`, is a
  markdown link; any other `[` opens an expression.
- `@name` is an icon only at the start of text or after a space or `{`, and
  only when `name` is a Phosphor icon; `lukas@tady.ch` stays text.
- **Expressions** in markup are written in square brackets, `[counter]`,
  `[user.name]`, `[items.length > 3 && Desc { Showing the first three. }]`.
  Ternaries and `&&` may return markup:
  `[done ? Badge { Done } : Badge { Waiting }]`.
- **Loops**: `[for t in tasks { Item { [t.name] } }]`, with an optional index:
  `[for t, i in tasks { … }]`.
- **Braces** open children in markup and an object literal in script
  (`tasks = [{ name: "Xero", done: false }];`).

### 3.3 Script

- **Variables**: `name = value;` declares or assigns. `const name = value;` for a
  constant. There is no `let` or `var`.
- **State**: `reactful(initial)` makes a value the UI follows; assigning to it
  re-renders. `stored(initial)` does the same and also keeps the value across
  reloads and for the Clot to read (Clapboards only; in an inline widget it
  acts like `reactful`). A saved value whose variable a later version removes
  is kept, and the linter tells the Clot so it can carry the value over.
- **Operators**: those of JavaScript, plus `++`, `--`, `+=`, `-=`, `*=`, `/=` on
  any variable.
- **Functions**: `fn total { a + b }`, with arguments only when there are any:
  `fn total(a, b) { a + b }`. The last expression without a semicolon is the
  return value; there is no `return`.
- **Components**: `comp Location(name, desc, img, minutes?) { Card { … } }`
  defines a component; `?` marks an optional argument (`null` when absent).
- **Event handlers** are statements, separated by `;`, written straight into
  the attribute: `click=counter++`, `click=save();close()`. Quotes are needed
  only when the code holds a space: `click="total += price"`.
- **Standard library**: `Math` (abs, min, max, round, floor, ceil), string and
  array methods that do not mutate shared state (`map`, `filter`, `find`,
  `some`, `every`, `slice`, `join`, `includes`, `toUpperCase`, …), `len(x)`,
  `now()`, `date(x)` and `format(date, "D MMM")`. Nothing else: no
  `window`, `document`, `fetch`, `eval`, timers or imports.

### 3.4 Values and inference

Attribute values and literals need no type syntax:

| Written | Is |
|---|---|
| `true`, `false` | boolean |
| `null` | null |
| digits, with no leading zero (`42`) | integer |
| digits with one `.` (`4.5`) | float |
| anything else, including `0123`, `1.2.3`, `2m`, `#fff` | string |

Quotes (`"…"` or `'…'`) are needed only for a string with a space. Identifiers
are letters, digits and `_` (no hyphens, so `a-b` is always subtraction).

### 3.5 Attributes

- **Flags**: an attribute with no value is `true` (`Card flat`). Writing
  `=true` or `=false` is a lint warning.
- **Variants** are mutually exclusive flags: `Button ghost sm`. Two flags of one
  group (`Button primary ghost`) is an error.
- **Dynamic values**: `value=[count * 2]`.
- **Several arguments** are joined with `+`: `b=2+red-700` (border width and
  colour).
- **Events**: `click`, `hover`, `change`, `submit`, `focus`, `blur`.
- **Styles on interaction**: `hoverStyle` and `activeStyle` take attributes in
  a string: `hoverStyle="bg=primary/10;fg=foreground"`. There are no other
  selectors or pseudo-classes.
- **Layout and spacing** (every component):
  - padding `p px py pt pr pb pl`, margin `m mx my mt mr mb ml` (Tailwind's
    spacing scale: `px=8` is 2rem);
  - borders `b bx by bt br bb bl`, each `width+colour`;
  - `row` and `column` (flex, on any component), `sx` and `sy` (space between
    children), `gap`, `grid-cols` and `grid-rows` (grid, by their presence:
    `grid-cols=3`), `justify-*`, `items-*`, `wrap`;
  - `w`, `h`, `max-w` (Tailwind sizes or `full`).
- **Colour attributes** (`bg`, `fg`, and the colour part of borders) take the
  theme tokens (`card`, `primary`, `muted-foreground`, `highlight`, …) or
  Tailwind colours (`red-600`, `white`, `blue-700/60`). Theme tokens follow
  light and dark; Tailwind colours do not, so the skill prefers tokens.
- **No `class` or `style`**, and no corner radius attribute: radii are
  automatic (3.7).

### 3.6 Submitting to the Clot

`Button submit { Send }` collects every named input in the widget (`Input`,
`Select`, `Checkbox`, `Switch`, `Slider`, `Options`, `Calendar picker`) and
sends them as an ordinary message from the user, starting with "From the
widget:" and one `label: value` line per input. An input's name is its `name=`
attribute, or else its `Label`'s text. After sending, the widget freezes and
shows what was submitted, on every device and after a reload; a widget is
submitted once.

### 3.7 Corner radii

The renderer gives the outermost component with a background a radius from
its size (12px for a card up to 480px wide, 16px above). Every nested component
whose background differs from its parent's gets the parent's radius minus the
parent's padding, never below 4px. Components without a background, such as
`Card flat`, pass the radius through untouched.

## 4. The catalog

Every component is a shadcn/ui component (or a named library) restyled to the
design system, built to work at phone width, with a skeleton for anything that
loads data.

### 4.1 Base (inline widgets and Clapboards)

| Component | Built on | Notes |
|---|---|---|
| `Card` | Card | `flat` removes border, shadow and background, to group content without a card-in-card look |
| `H1` `H2` `H3` | | never skip a level |
| `Desc` | CardDescription | muted text, only where meaning is not obvious |
| `Text` | p | |
| `Button` | Button | variants `primary` (default) `secondary` `ghost` `destructive` `outline`; sizes `sm` `lg`; `icon`; `submit` (3.6) |
| `Input` | Input, Textarea | `multiline` for a textarea; `name`, `placeholder`, `value` |
| `Select` | Select | children are `Item`s |
| `Checkbox` | Checkbox | |
| `Switch` | Switch | |
| `Slider` | Slider | |
| `Options` | RadioGroup, ToggleGroup | variants `radio` (default) `switch` `check`; children are `Item`s |
| `Label` | Label | |
| `Accordion` | Accordion | children are `Item title=… { … }` |
| `Tabs` | Tabs | children are `Item title=… { … }` |
| `Progress` | Progress | `value` |
| `Kbd` | Kbd | |
| `Code` | a highlighted code block (Shiki) | `lang`; `diff` shows a unified diff with added and removed lines |
| `Chart` | Evil Charts, ECharts engine | variants `line` `bar` `area` `pie` `radar`; `data`, `x`, `y` |
| `Table` | TanStack Table in shadcn's Table | `data`, `columns`; sorting and filtering on |
| `Calendar` | Calendar | `picker` turns it into an input that opens a calendar |
| `Badge` | Badge | status only, and rarely |
| `List`, `Item` | | `Item` is also the child of Select, Options, Tabs and Accordion |
| `Image` | `next/image` through the image proxy (7) | `src`; the child text is the alt text |
| `Stat` | | a number with its label, for figures that are the point |
| `Alert` | Alert | a real warning only |
| `ClapboardLink` | the ClapboardLink card | `to=<slug>`; shows the Clapboard's title |
| `File` | the File card | `path`: a file in the Clot's container (`~/…` or absolute); the child text, if any, replaces the file name as the label; shows a type icon, the name, the size and a download button (section 5.1) |
| icons | `@phosphor-icons/react` | `@name` in text or children (`@arrow-right`), `@name:bold` and `@name:fill` for weights |

### 4.2 Clapboards only

| Component | Built on | Notes |
|---|---|---|
| `Title` | | sets the Clapboard's title; required, once |
| `Menu` | Menubar | at the top left of the Clapboard |
| `Crumb` | Breadcrumb | |
| `Drawer` | Sheet | `left` or `right` |
| `Dialog` | Dialog | |
| `Toast` | Sonner | shown from a handler: `toast("Saved")` |
| `Tooltip` | Tooltip | desktop only; never the only place information lives |
| `Paginate` | Pagination | |
| `Spinner` | Spinner | for a running action, never for loading data |
| `Resizable` | Resizable | |
| `Empty` | Empty | an empty state with what will appear and how to add the first |

## 5. Inline widgets in a reply

- A Clot writes a widget as a fenced block, ` ```claritee `, anywhere in a
  markdown reply. A block that shows Claritee source rather than rendering it
  uses ` ```claritee-source `.
- **Streaming**: the chat renders markdown as it arrives; an open `claritee`
  fence shows a skeleton until the fence closes, then the widget.
- **The system prompt** of every main session gets a Claritee section: the
  language (section 3, condensed), the base catalog with each component's
  attributes, the token-saving rules, and when to use a widget or a
  Clapboard. Worker sessions get none, so workers report to the main session in
  markdown and code. Because resumed sessions keep their system prompt, the
  section reaches a Clot at its next rollover or `/close`.
- Inline widgets use the base catalog only; a Clapboard-only component in a
  reply is a lint error that points the Clot to a Clapboard.
- **Token-saving rules**, enforced as lint warnings: no `=true`/`=false`, no
  quotes without a space, `x++` rather than `x = x + 1`, no `()` on a function
  without arguments, no radius attributes.
- **Linting before the user sees it**: a Stop hook on main-session turns parses
  every `claritee` block of the turn's reply. If one has errors, the hook stops
  the turn from ending and gives the Clot the errors with their lines; the Clot
  writes the block again. The broken block shows as a skeleton meanwhile. After
  two failed attempts the turn ends, and the block shows "This widget couldn't
  be shown" with its source folded under it. Warnings never stop a turn; they
  are placed as a note before the Clot's next turn.
- **Runtime errors** (a missing variable, a failed function) replace only the
  failing component with a small error placeholder, and are reported the same
  way as warnings.
- A worker's report goes to the main session, never to the chat. A `claritee`
  block in it reaches the main session as `claritee-source`, with a line saying
  widgets are for the user; the main session writes its own if one helps.

### 5.1 Files

A Clot gives the user a file it made (an export, a report, a recording) by
naming it in a `File` component, with no extra copying step.

- **Snapshot at the end of the turn**: the Stop hook, after linting, reads every
  `File` path in the turn's blocks from the container and copies the file into
  the daemon's storage. The download is that copy: later changes to the file in
  the container do not change it, and it survives rebuilds of the container.
- **Checks**: the path must name a regular file of at most 100 MB, outside the
  Clot's login and credential folders (`~/.claude`, the scoped credentials).
  A missing file, a directory, a file that is too big or a refused path is an
  error, handled like a lint error: the Clot gets it and writes the block
  again, with the same two attempts.
- **Storage**: files are kept by their content's hash under
  `data/files/<clot>/`, so the same file named twice is stored once. A file is
  kept as long as a message or a kept Clapboard version names it, and backed up
  with the rest of `data/`.
- **Download**: the card's button downloads the file under its name; nothing
  opens in the browser. On a phone, tapping the card downloads it.
- **Several files**: `File`s next to each other in a block render as one card
  with one row per file, divided by lines, never as a card each.
- A worker names a file in its report as a path; the main session writes the
  `File` for the user, since the worker's worktree is in the same container.

## 6. Clapboards

### 6.1 Making and publishing

- A Clot (main session or worker) writes `~/clapboards/<slug>.clap` in its
  container with its ordinary Write and Edit tools. `<slug>` is lowercase
  letters, digits and `-`. A main session is locked to reading; the lock lets
  it write files under `~/clapboards/` and nowhere else, as it does for its
  memory folder.
- It publishes once with the daemon tool `clapboard_publish(slug)`. The daemon
  reads the file from the container, lints it with the full (base and
  Clapboard) catalog, and on success stores it as version 1 and returns the
  Clapboard's address. On errors it returns them, and nothing is published.
- **Live editing**: after that, a PostToolUse hook on Write and Edit for files
  under `~/clapboards/` sends every save of a published Clapboard to the
  daemon, which lints and stores a new version and sends a
  `clapboard.updated` event. An open pane re-renders in place, keeping
  `reactful` state where the variable still exists. A save with errors is not
  stored: the hook returns the errors to the Clot, and the last good version
  stays on screen.
- `File` paths in a Clapboard are copied when its version is stored (on publish
  and on each save), with the checks of 5.1; a failed check refuses the save
  like a lint error. To give the user a newer copy of a file, the Clot saves the
  Clapboard again.
- Other daemon tools: `clapboard_list`, `clapboard_unpublish(slug)`,
  `clapboard_state(slug)` (the `stored()` values) and
  `clapboard_versions(slug)`.
- Versions are kept under `data/clapboards/<clot>/<slug>/`; the newest 50 of
  each are kept.

### 6.2 State

- `reactful` state lives in the open page only.
- `stored` values are saved by the daemon per Clapboard and variable, written
  when they change (debounced), and shared across the user's devices. A new
  version keeps the values of variables it still declares.
- Data the Clot owns (a task list it keeps up to date) lives in the Clapboard's
  source as constants; the Clot edits the file to change it. Data the user
  changes lives in `stored()`.
- `Button submit` in a Clapboard sends the inputs to the Clot that owns it, as a
  message in that Clot's chat marked with the Clapboard's title.

### 6.3 Showing them

- Address in the web app: `/c/<clot>/<slug>`.
- Desktop: a ClapboardLink in a reply opens it in the side pane (4a section 7);
  the chat header's Clapboard button, beside the Info button, lists the Clot's
  Clapboards and appears once it has one. A Clapboard can also be opened full width by dragging the
  pane to the left edge.
- Phone: a ClapboardLink opens it full screen with a back button.
- The `Title` component sets the page title and the ClapboardLink's label;
  `Menu` sits at the top left of the Clapboard.

## 7. Security

- Claritee is interpreted, never compiled to JavaScript: the interpreter has no
  access to the page, the network or storage beyond what section 3 lists. Text
  from emails or issues that a Clot puts in a widget cannot run code.
- Markdown in widgets and replies renders no raw HTML.
- External links open in a new tab with `rel="noopener noreferrer"`.
- `Image` loads through the image proxy (the browser loads `/api/d/img?url=`, which the web app's daemon proxy forwards to the daemon's `/api/v1/img?url=`; images are not run through Next's optimizer, and only raster images are served): https
  only, `image/*` responses only, at most 10 MB, private and loopback addresses
  refused, results cached. A Clot's own file can be shown from
  `~/clapboards/assets/`, served by the daemon.
- A ClapboardLink can only open a Clapboard of one of the user's own Clots.
- `File` downloads go through the same daemon proxy as images, always as an
  attachment (`Content-Disposition: attachment`, `nosniff`), so a file is never
  run or shown as a page. The path is resolved inside the container (no
  symlinks out of it), and only the Clot that wrote the block is read from.
- Lint limits: 64 KB of source per block, 256 KB per Clapboard; loops and
  recursion capped at 10,000 steps per render, after which the component shows
  its error placeholder.

## 8. The Clapboards skill

`plugin/skills/clapboards/`, copied into every container with the rest of the
plugin, not loaded by default. Its description says when to use it: something
interactive, too big for a reply, or that the user will open more than once.
Its files:

- `SKILL.md`: making, publishing and editing a Clapboard (section 6), `stored`
  versus source data, the Clapboard-only components with their use and
  purpose, and the design rules below. It names `landing-pages.md` and says to
  read it only when designing a landing or marketing page.
- `components.md`: every component of both catalogs with its attributes and an
  example.
- `landing-pages.md`: the landing-page rules below.

**Design rules in `SKILL.md`** (also a short version in the system prompt's
Claritee section):

- No eyebrows, labels or chips above headings that say nothing.
- No unicode symbols as icons (→, ✓); use the icon library.
- No unicode dots (·) to separate words.
- No arrow, icon or unicode, on every button.
- No sparkle icons scattered around.
- Never skip a heading level.
- Descriptions only where meaning is not obvious.
- No top bars on dashboards that do nothing.
- No one-sided borders.
- At most two things change on hover.
- No em dashes in copy.
- No "it's not (just) X, it's Y" or "stop X-ing, start Y-ing".
- No "quiet", "real", "actual" or "actually" without a reason.
- No closing lines, calls to action or notes made of two or three fragments of
  two to four words ("Your servers. Your hardware. Our dashboard.", "One
  gateway. Every model.").
- No "Do X once. Then (one) Y does <seemingly impressive action or
  capability>." ("Install the Hostinger CLI once. Then one command gives your
  app a link anyone can open.").
- No cards in cards; use `Card flat` to group inside a card.
- Not everything in its own card.
- `Badge` only for status, and rarely.
- Skeletons for loading data, spinners only for running actions.
- If another skill suggests Claude Design or an HTML file, consider a widget or a
  Clapboard first; it usually does the job.

**`landing-pages.md`**:

- No stats or metrics after the hero that mean nothing.
- No made-up testimonials.
- No italicised random words in headlines.
- Not every section fades in.
- No numbered sections for everything.
- No three identical cards in a row.
- One or two calls to action on the page, never the same one repeated in a
  section.

## 9. Testing

- **Package (vitest)**: golden tests for the lexer and parser (every construct
  in section 3, and error positions for malformed input); type inference;
  every lint rule, as an error or a warning; the interpreter (operators,
  functions, components, loops, the step cap, no access outside its library).
- **Renderer**: component tests for every catalog component and attribute,
  submit collection, radius computation, `stored` sync, runtime error
  placeholders; Playwright screenshots of a sample of each component in both
  themes at desktop and phone widths.
- **Daemon**: the Stop hook (errors stop the turn, two retries, warnings as
  notes), the PostToolUse hook (versions, rejected saves keep the last good
  one), `clapboard_*` tools, the image proxy's refusals, `File` snapshots (a
  missing, too big or refused path is sent back to the Clot; a later change in
  the container leaves the download unchanged).
- **Live checks**: a Clot answers a few ordinary questions and its widgets
  render cleanly; a Clot builds a progress-tracker Clapboard from a prompt, the
  user ticks items on the phone, and the Clot reads them back with
  `clapboard_state`; an edit to the file appears in the open pane without a
  reload.

## 10. Done when

- Clot replies render Claritee widgets inline, linted before the user sees
  them, in both themes and at phone width.
- `Button submit` sends a widget's inputs to the Clot.
- A Clot can hand the user a file it made with `File`, downloadable on desktop
  and phone.
- A Clot can publish a Clapboard, edit it live, and read what the user stored
  in it; it opens in the side pane on desktop and full screen on a phone.
- The Clapboards skill is in every container, and a Clapboard made without any
  extra instructions follows its design rules.

## 11. Risks

- Models have never seen Claritee; quality depends on the system prompt
  section and the linter's feedback. The token cost of that section is paid on
  every main-session turn (cached).
- A Stop hook retry costs a model call per failed widget.
- Charts and tables are the heaviest components; on a phone they may render
  slowly with large data.
