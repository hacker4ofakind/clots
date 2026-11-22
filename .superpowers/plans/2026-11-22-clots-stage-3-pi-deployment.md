# Clots Stage 3: Headless Deployment on the Pi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. This plan gives structure and decisions, not code. You write the implementation (TDD per task). Track tasks with the checkboxes. After all tasks, run the **Manual Verification Checklist** (or hand it to the user if they asked to do it), then fill in **Implementation Notes**.

**Goal:** The daemon runs unattended on the Raspberry Pi 5 as a systemd service with the Home and Truecast Clots, deployable from the PC with `npm run deploy`, with nightly backups, while the PC's development setup keeps running unchanged.
**Specs:** `.superpowers/specs/2026-11-22-clots-stage-3-pi-deployment-design.md` ("spec section N" below). Parent: `.superpowers/specs/2026-10-10-clots-design.md`.
**Architecture:** No daemon code changes. Stage 3 adds a `deploy/` folder: a rerunnable setup script, systemd units for the daemon and the backup, a sudoers rule, an update script the PC runs over SSH, and a backup script. The Pi clones the public repository from GitHub and runs the daemon from its checkout exactly as `npm run daemon` does on the PC.
**Tech Stack:** bash, systemd, Docker Engine, Node.js 26.13.1 (NodeSource), Tailscale Funnel, sqlite3 CLI, Ubuntu Server 26.04.1 on arm64.

## Global Constraints

- Pi: hostname `clots`, user `clots`, home `/home/clots`, checkout `/home/clots/clots`, reached from the PC as `ssh clots@clots`.
- Public URL: `https://clots.tailf707aa.ts.net`; daemon port 8787 (it listens on `127.0.0.1` only, `src/intake.ts`).
- Node.js exactly 26.13.1, held with `apt-mark hold nodejs`.
- Image tag stays `clots-clot:dev` (what `npm run image` builds and the config's `image` names).
- Backups: `/home/clots/clots-backups`, one archive per night named by date, 7 kept.
- Every script is rerunnable: a second run changes nothing and exits 0.
- The PC's setup (`clots.config.json`, `.env`, the "Clots (Dev)" server, the laptop Funnel) is not touched.

## File Map

- `deploy/setup-pi.sh` — one-time, rerunnable host setup, run with `sudo` (spec section 5).
- `deploy/clots.service` — the daemon's systemd unit (spec section 6).
- `deploy/clots-sudoers` — lets `clots` run `systemctl restart clots` without a password; installed to `/etc/sudoers.d/clots`.
- `deploy/update.sh` — the Pi side of `npm run deploy` (spec section 7).
- `deploy/backup.sh` — makes one backup archive and prunes old ones (spec section 9).
- `deploy/clots-backup.service`, `deploy/clots-backup.timer` — run `backup.sh` nightly.
- `package.json` — add the `deploy` script.
- `.gitattributes` — `*.sh`, `deploy/*` stored with LF.
- `README.md` — a "Deploy on a server" section.
- `.superpowers/specs/2026-10-10-clots-design.md` — only if the build changes something it states (memory: the spec tracks the build).

## Key Decisions & Gotchas

- **Line endings and the executable bit.** The repo is edited on Windows. Without `.gitattributes` forcing LF, bash on the Pi fails on `\r`. Set the executable bit in git with `git update-index --chmod=+x deploy/*.sh`; Windows checkouts don't carry it otherwise.
- **The Pi pulls from GitHub,** so the scripts must be pushed before any live check. Work on branch `stage-3`, push it, and have the Pi's checkout follow `stage-3` for the live checks. After the PR merges, switch the Pi's checkout to `master` (`git switch master`) and run one more `npm run deploy`. This is why the commit strategy below differs from the default.
- **Host programs the daemon needs:** only `docker` and `git` (the rulebook folder is a git repository, `src/rulebook.ts`). `gh` is used only inside containers.
- **tsx is a devDependency.** Never set `NODE_ENV=production` in the unit and never `npm ci --omit=dev`, or the service can't start.
- **NodeSource pinning.** Add NodeSource's apt repository for the 26.x line (keyring in `/etc/apt/keyrings`, a `sources.list.d` entry; don't pipe their setup script into bash). Then install `nodejs=<exact package version>`, taking the full version string for 26.13.1 from `apt-cache madison nodejs` (it has a `-1nodesource1` style suffix). Then `apt-mark hold nodejs`. If 26.13.1 isn't in the repository, stop and tell the user.
- **Docker Engine** comes from Docker's apt repository for Ubuntu (`docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`), architecture from `dpkg --print-architecture`. `usermod -aG docker clots` only takes effect in new logins: the script says so at the end. The service is unaffected because systemd reads groups at start.
- **Rerunnable setup:** check before each step (package installed, line present, file identical, unit enabled). Install unit and sudoers files only when the content differs, then `systemctl daemon-reload` once. Validate the sudoers file with `visudo -cf` before moving it into place. A broken file in `/etc/sudoers.d` locks `sudo` out entirely.
- **Clone vs. existing checkout:** if `/home/clots/clots` exists, setup leaves it alone (update.sh owns it from then on). The clone runs as `clots` (`sudo -u clots git clone …`) so the files aren't owned by root.
- **First image build** happens in setup (as `clots`, if the image doesn't exist yet), so the first start doesn't build it. Time it; the time is the spec's build-time check.
- **Setup does not start the service.** It enables it, but it only starts once `.env` and `clots.config.json` exist. The script prints which are missing and, when both exist, starts the service. Otherwise systemd would loop restarting a daemon that throws on missing config.
- **Funnel:** `tailscale funnel --bg 8787` persists across reboots. Run it only if `tailscale funnel status` doesn't already show 8787. If the tailnet policy doesn't allow Funnel on this node, the command prints a link: surface it and stop.
- **The unit:** `User=clots`, `WorkingDirectory=/home/clots/clots`, `ExecStart=/usr/bin/node --env-file=.env --import tsx src/daemon.ts`, `After=`/`Wants=` `docker.service network-online.target`, `Restart=always`, `RestartSec=5`. Leave `KillMode` at its default (control-group), so `docker exec` clients die with the daemon; the daemon already handles a session left running in a container at startup.
- **update.sh change detection:** record `git rev-parse HEAD` before `git pull --ff-only`. If HEAD didn't move, print "Already up to date" and exit 0 without restarting. Otherwise diff the names between old and new HEAD: `package-lock.json` → `npm ci`; anything under `docker/` → `docker build -t clots-clot:dev docker`. Then `sudo systemctl restart clots`, `sleep 5`, `systemctl status clots --no-pager` and `journalctl -u clots -n 20 --no-pager`. Exit non-zero if the service isn't `active`. The dirty-checkout check is `git status --porcelain` (non-empty → error naming the files).
- **`npm run deploy`** is `ssh clots@clots clots/deploy/update.sh`. Use a path relative to home, not `~`, because npm runs scripts through cmd on Windows.
- **Sudoers rule:** exactly `clots ALL=(root) NOPASSWD: /usr/bin/systemctl restart clots`. Nothing broader.
- **backup.sh:** run as `clots` from the checkout. `sqlite3 data/clots.db ".backup '<tmp>/clots.db'"` (the online backup API, safe beside the running daemon in WAL mode). Copy the rulebook folder (`rulebook/`, `.git` included) beside it, then `tar czf clots-backups/<YYYY-MM-DD>.tar.gz`. Write to a temp name and rename, so a failed run never leaves a half archive. Prune to the 7 newest. A second run on the same day replaces that day's archive. If `data/clots.db` doesn't exist yet, exit 0 with a message.
- **Timer:** `OnCalendar=*-*-* 03:30` (Pi local time, Africa/Johannesburg), `Persistent=true` so a night missed while the Pi was off runs at the next boot.
- **Checking the scripts:** run `shellcheck` through Docker on the PC (`docker run --rm -v "$PWD:/mnt" koalaman/shellcheck:stable deploy/*.sh`); it must pass with no warnings. Also run `systemd-analyze verify` on the units on the Pi.

## Tasks

### Task 1: Host setup and the service
**Files:** `deploy/setup-pi.sh`, `deploy/clots.service`, `deploy/clots-sudoers`, `.gitattributes`
**Interfaces:**
- Produces: the installed unit `clots.service`; `/etc/sudoers.d/clots`; checkout at `/home/clots/clots`; image `clots-clot:dev`; Funnel on 8787.

**Build:**
- The steps of spec section 5 in this order: apt prerequisites (`ca-certificates curl git sqlite3 build-essential python3`), Docker, Node, cloud-init disabled, clone, `npm ci` and the image build as `clots`, units and sudoers installed, the service enabled, Funnel, then the summary.
- The script refuses to run without root, and refuses on a host with no `clots` user.
- It installs `clots-backup.service` and `clots-backup.timer` too (written in Task 3). Have the install step take every unit file in `deploy/` so Task 3 needs no change here.
- The summary prints the Node and Docker versions, the image build time, whether `.env` and `clots.config.json` exist, and the Funnel URL.

**Tests (behaviours):**
- On the Pi, a first run installs everything and ends with the summary listing `.env` and `clots.config.json` as missing.
- A second run reports each step as already done and changes no file (compare `ls -l --time-style=full-iso` of `/etc/systemd/system/clots*` and `/etc/sudoers.d/clots` before and after).
- `node --version` prints `v26.13.1`; `apt-mark showhold` lists `nodejs`.
- `sudo -u clots sudo -n systemctl restart clots` is allowed; `sudo -u clots sudo -n systemctl stop docker` is refused.

**Done when:** shellcheck passes; both runs behave as above on the Pi.

- [ ] Task 1 complete

### Task 2: Deploying from the PC
**Files:** `deploy/update.sh`, `package.json` (add `"deploy"`)
**Interfaces:**
- Consumes: the checkout, the sudoers rule and the unit from Task 1.

**Build:**
- update.sh as described in Key Decisions. It prints one line per step it runs or skips ("npm ci: lockfile unchanged, skipped").
- It is run as `clots` (over SSH); it never uses `sudo` except for the one allowed command.

**Tests (behaviours):**
- With no new commits: "Already up to date", exit 0, the service's start time unchanged.
- A commit touching only `README.md`: pull, both steps skipped, the service restarted and `active`.
- A commit touching `docker/Dockerfile`: the image rebuilt, and on restart the daemon logs that it recreated each container, keeping its volumes.
- A local edit in the Pi's checkout: exits non-zero naming the file, nothing pulled.
- With an unknown key added to the Pi's `clots.config.json` (the config is gitignored, so the checkout stays clean) and a README-only commit pushed: update.sh restarts, finds the service not `active`, exits non-zero and prints the log lines with the config error. Remove the key and deploy again afterwards.

**Done when:** shellcheck passes; the behaviours above observed from the PC through `npm run deploy`.

- [ ] Task 2 complete

### Task 3: Nightly backups
**Files:** `deploy/backup.sh`, `deploy/clots-backup.service` (`Type=oneshot`, `User=clots`, the checkout as working directory), `deploy/clots-backup.timer`
**Interfaces:**
- Consumes: Task 1's install step, which picks the new units up when setup is rerun.

**Build:**
- backup.sh and the timer as described in Key Decisions.
- Rerun `setup-pi.sh` to install and enable the timer (`systemctl enable --now clots-backup.timer`; add that to setup's enable step).

**Tests (behaviours):**
- `sudo systemctl start clots-backup` while the daemon runs → `clots-backups/<today>.tar.gz` exists; extracted, `sqlite3 clots.db "PRAGMA integrity_check"` prints `ok` and `rulebook/` is present.
- With 9 archives present (make dated dummies), a run leaves the 7 newest.
- Running twice in a day leaves one archive for that day.
- `systemctl list-timers clots-backup.timer` shows the next run at 03:30.

**Done when:** shellcheck passes; the behaviours above observed on the Pi.

- [ ] Task 3 complete

### Task 4: README and bring-up
**Files:** `README.md`

**Build:**
- A "Deploy on a server" section: the OS assumptions (spec section 3), `sudo ./deploy/setup-pi.sh` (or the curl/clone order for a fresh machine: clone first, then run it from the clone), creating `.env` (mode 600) and `clots.config.json` on the server, logging each container in, `npm run deploy`, `journalctl -u clots`, and where the backups are. Say that the server needs a Discord bot and server of its own if a development daemon also runs.
- Then bring the Pi up with the user. The `[user-only]` steps are listed under MV-shared setup below.

**Done when:** the service is `active` on the Pi with both Clots, and the checklist below passes.

- [ ] Task 4 complete

## Commit Strategy

One commit with all of Tasks 1–4's files on branch `stage-3`, pushed before the Pi first clones (the Pi can't test what isn't on GitHub). Fixes found during the live checks are further commits on the same branch, delivered to the Pi with `npm run deploy`, which also exercises Task 2. Open the PR when the checklist passes.

## Manual Verification Checklist

**Shared setup:**
1. `[user-only]` Discord: create a new application and bot in the Developer Portal; enable the **Message Content** intent; create a new server; invite the bot with the same permissions its counterpart has in "Clots (Dev)" (Server Settings → Roles shows them; it must at least manage channels and pin messages). Give the bot token and the server id to the executor through `.env` on the Pi, not in chat.
2. `[user-only]` GitHub, on `Truecast-Org/Truecast-Build`: invite `clots-dot-dev` as an outside collaborator with Write and accept the invite as `clots-dot-dev`. Add a webhook: payload URL `https://clots.tailf707aa.ts.net/webhooks/github`, content type `application/json`, a new random secret, events: Issues, Issue comments, Pull requests, Pull request reviews, Workflow runs.
3. On the Pi: `git clone https://github.com/hacker4ofakind/clots.git ~/clots && cd ~/clots && git switch stage-3 && sudo ./deploy/setup-pi.sh`.
4. `[user-only]` On the Pi: create `~/clots/.env` (mode 600) with `DISCORD_BOT_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLOT_GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` (the new one). Create `~/clots/clots.config.json` from `clots.config.example.json`: `timeZone` `Africa/Johannesburg`, `image` `clots-clot:dev`, `discord.guildId` = the new server, `discord.userId` as on the PC, `home: true`, `publicUrl` `https://clots.tailf707aa.ts.net`, `clots: [{ "name": "truecast", "repoUrl": "https://github.com/Truecast-Org/Truecast-Build.git" }]`, no `sources`, no `mcpServers`.
5. Rerun `sudo ./deploy/setup-pi.sh`: it starts the service.
6. `[user-only]` `docker exec -it clot-home claude /login` and `docker exec -it clot-truecast claude /login`.

#### MV-1: The service is up with both Clots
- **Steps:** `systemctl is-active clots`; `journalctl -u clots -n 50 --no-pager`; `docker ps --format '{{.Names}}'`.
- **Expected:** `active`; no error or stack trace in the log; `clot-home` and `clot-truecast` running. The new server has each Clot's category and channel.
- **How the executor runs it:** SSH.

#### MV-2: Each Clot answers in Discord
- **Steps:** in the new server, send "What repository are you working on?" in the Truecast Clot's channel, and "Hello" in the Home Clot's.
- **Expected:** a reply in each channel within a minute; the Truecast Clot names `Truecast-Org/Truecast-Build`. Nothing appears in "Clots (Dev)".
- **How the executor runs it:** `[user-only]` (needs the user's Discord account).

#### MV-3: A GitHub issue reaches the Clot through Funnel and ends in a pull request
- **Steps:** open an issue on Truecast-Build as the user asking for a small, harmless change (for example a typo fix in the README).
- **Expected:** GitHub's webhook page shows a 2xx delivery to `clots.tailf707aa.ts.net`; the issue appears in the Truecast Clot's channel; a pull request from `clots-dot-dev` follows. The PC's daemon logs nothing about it.
- **How the executor runs it:** `gh issue create -R Truecast-Org/Truecast-Build …` and `gh api repos/Truecast-Org/Truecast-Build/hooks/<id>/deliveries`; the Discord part is `[user-only]`.

#### MV-4: The PC's development setup is unaffected
- **Steps:** on the PC, `npm run daemon`; message the encryptify Clot in "Clots (Dev)".
- **Expected:** it answers as before; the laptop Funnel URL still receives encryptify's webhooks; the Pi's server stays silent.
- **How the executor runs it:** start the daemon in the background; the Discord message is `[user-only]`.

#### MV-5: Survives a reboot
- **Steps:** `sudo reboot`; after 2 minutes `ssh clots@clots systemctl is-active clots`; send a message to the Truecast Clot.
- **Expected:** `active` with no manual step; the Clot answers and its session continues (it remembers the MV-2 exchange).
- **How the executor runs it:** SSH; the Discord message is `[user-only]`.

#### MV-6: Survives a power cut while idle
- **Steps:** with no turn running, pull the Pi's power, wait 10 seconds, plug it back in.
- **Expected:** as MV-5; `PRAGMA integrity_check` on `data/clots.db` prints `ok`.
- **How the executor runs it:** `[user-only]` (physical).

#### MV-7: A deploy mid-turn resumes the turn
- **Steps:** ask the Truecast Clot for something that takes several minutes; while it runs, push a README-only commit and `npm run deploy`.
- **Expected:** update.sh restarts the service and exits 0; the turn resumes and finishes after the restart, with no duplicate reply.
- **How the executor runs it:** CLI for the deploy; observing the turn is `[user-only]`.

#### MV-8: Memory and build time on the Pi
- **Steps:** ask the Truecast Clot for three independent small changes at once so that three workers run (`maxWorkers` 3). While they run, `free -m` and `docker stats --no-stream` every 30 seconds; afterwards `journalctl -k | grep -i -E "oom|killed process"`. Record the image build time from setup's summary.
- **Expected:** all three workers finish; available memory never under 1 GB; no OOM lines. Record peak usage and the build time in Implementation Notes.
- **How the executor runs it:** SSH; starting the workers is `[user-only]`.

#### MV-9: Backups
- **Steps:** as Task 3's tests, plus after the first 03:30 run, `ls ~/clots-backups`.
- **Expected:** that night's archive exists and its database passes `integrity_check`.
- **How the executor runs it:** SSH.

#### MV-10: Back on master
- **Steps:** after the PR merges: on the Pi `cd ~/clots && git switch master`, then `npm run deploy` from the PC.
- **Expected:** the service restarts on master's code and is `active`; `git -C ~/clots status` is clean on `master`.
- **How the executor runs it:** SSH and CLI.

## Out of Scope

Onboarding, the `clots` CLI, email and Composio on the Pi, the browser, the web UI, copying backups off the Pi, and moving to the x64 machine.

## Implementation Notes
_Filled in by the executor: deviations and why, changed names/interfaces, surprises, notes for the next stage's planner._
