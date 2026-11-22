# Clots stage 3: headless deployment on the Pi

Date: 2026-11-22
Status: designed; not built.
Parent design: `.superpowers/specs/2026-10-10-clots-design.md` (stage list in
section 16). Plan: `.superpowers/plans/2026-11-22-clots-stage-3-pi-deployment.md`.

## 1. What stage 3 delivers

The daemon runs unattended on the Raspberry Pi 5 as a systemd service, with two
Clots: Home and Truecast. The user talks to them in a Discord server of their
own. The Pi comes back by itself after a reboot or a power cut, and new code
reaches it with one command run on the PC. The development setup on the PC keeps
running beside it, unchanged.

The Pi stands in for the always-on x64 machine (likely a GMKtec M6 Ultra on
Ubuntu Server) until it arrives. Everything stage 3 adds to the repository is
written so that it can be run again on that machine.

## 2. Where stage 3 sits in the parent design

Stage 3 builds the deployment the parent design assumes in section 2 (the daemon
on an always-on host, systemd restarting it) and the Pi check in section 14.
Onboarding (parent section 11) and the `clots` CLI are not part of it; onboarding
will be built in the web UI.

## 3. The Pi as found

The OS was set up by hand before this stage, and is not part of the plan:

- Raspberry Pi 5, 8 GB, 512 GB microSD, on Ethernet to the home router. The
  user has no admin access to the router.
- Ubuntu Server 26.04.1, hostname `clots`, user `clots` (SSH by key only; the
  password is for `sudo`), time zone Africa/Johannesburg.
- `eth0` set to DHCP with `netplan set`; `avahi-daemon` installed.
- Tailscale installed, joined to the user's tailnet as `clots`, with key expiry
  disabled and automatic updates on. The PC reaches it as `ssh clots@clots`.

## 4. Two setups that never cross

Development continues on the PC. The two daemons share nothing a second daemon
could steal from the first:

| | PC (development) | Pi |
|---|---|---|
| Discord | the existing bot, in the server renamed "Clots (Dev)" | a new bot, in a new server |
| Public URL | `https://laptop-nj7mbno6.tailf707aa.ts.net` | `https://clots.tailf707aa.ts.net` |
| Clots | encryptify and the home Clot | Home and Truecast |
| Sources | GitHub, the test email accounts, Composio | GitHub only |
| Config and secrets | `clots.config.json`, `.env` on the PC | their own copies, created on the Pi |

A second bot is needed because two daemons logged in with the same bot token
would both receive every message. The PC keeps its Composio project; the Pi has
none in stage 3, so no second project is needed yet. Email and Composio accounts
are added to the Pi once the web UI makes that easy.

Both setups use the same Claude subscription, so usage on one counts against the
other.

## 5. The Pi's base setup

`deploy/setup-pi.sh`, run once on the Pi with `sudo`, installs what the daemon
needs. Every step checks whether it is already done, so the script can be run
again safely:

- Docker Engine from Docker's own apt repository; the `clots` user is added to
  the `docker` group.
- Node.js 26.13.1 from NodeSource's apt repository, held at that version
  (`apt-mark hold nodejs`). A new version is installed by changing the version in
  the script and running it again.
- `git`, `sqlite3`, and the build tools `npm ci` needs if a native module has no
  prebuilt binary for arm64 (`build-essential`, `python3`).
- cloud-init disabled (`/etc/cloud/cloud-init.disabled`), so it cannot rewrite
  the network settings.
- The repository cloned to `/home/clots/clots`. It is public, so no credential is
  needed.
- The systemd units from `deploy/` installed and enabled (sections 6 and 9).
- Tailscale Funnel on: `tailscale funnel --bg 8787`, which serves the daemon at
  `https://clots.tailf707aa.ts.net` on port 443.

The script does not write `.env` or `clots.config.json`: the user creates them on
the Pi (section 8). It ends by printing which of the two are still missing.

## 6. The service

`deploy/clots.service`:

- runs as `clots`, in `/home/clots/clots`, with the same command as
  `npm run daemon` (`node --env-file=.env --import tsx src/daemon.ts`);
- starts after `docker.service` and `network-online.target`, and wants both;
- `Restart=always`, with a few seconds between restarts;
- logs to the journal, read with `journalctl -u clots`.

Stopping the daemon mid-turn needs no new code. The parent design's crash
recovery already resumes an interrupted turn, and at startup the daemon already
ends a session that a `docker exec` kept running in a container (parent section
12).

## 7. Deploying

`npm run deploy` on the PC runs `ssh clots@clots ~/clots/deploy/update.sh`.
`deploy/update.sh`, on the Pi:

1. Stops with an error if the Pi's checkout has local changes.
2. `git pull --ff-only`.
3. `npm ci` if `package-lock.json` changed in the pull.
4. Rebuilds the Clot image (`docker build -t clots-clot:dev docker`) if anything
   under `docker/` changed. The daemon already recreates a container made from
   an older image at startup, keeping its volumes.
5. `sudo systemctl restart clots` (allowed without a password for that one
   command, through a file in `/etc/sudoers.d`, written by the setup script).
6. Waits a few seconds and prints the service's state and its latest log lines.

A deploy during a turn interrupts that turn, and the crash recovery resumes it.

## 8. The two Clots

`clots.config.json` on the Pi:

- `"home": true`, giving the Home Clot, which has no repository;
- one Clot, `truecast`, bound to
  `https://github.com/Truecast-Org/Truecast-Build.git`;
- `publicUrl` set to `https://clots.tailf707aa.ts.net`;
- `discord` set to the new server and the user's Discord id;
- no `sources` beyond GitHub.

`.env` on the Pi holds the new bot's token, a new `GITHUB_WEBHOOK_SECRET` of its
own, `CLOT_GITHUB_TOKEN` (the `clots-dot-dev` token) and
`CLAUDE_CODE_OAUTH_TOKEN`. It is readable only by `clots` (mode 600).

On GitHub, the user, an admin of Truecast-Org:

- adds `clots-dot-dev` to Truecast-Build as an outside collaborator with Write
  access;
- adds a repository webhook to
  `https://clots.tailf707aa.ts.net/webhooks/github`, content type JSON, with the
  new secret, for the events the daemon reads: issues, issue comments, pull
  requests, pull request reviews and workflow runs.

Each container is logged in to Claude once by hand
(`docker exec -it clot-<name> claude /login`), as in development.

## 9. Backups

`deploy/clots-backup.service`, run nightly by `deploy/clots-backup.timer`,
writes one archive to `/home/clots/clots-backups` named by date, holding:

- a consistent copy of the database, made with `sqlite3 data/clots.db
  ".backup ..."`, which is safe while the daemon runs;
- the rulebook folder.

It keeps the 7 newest archives and deletes older ones. The backups sit on the
same card as the data, so they protect against a broken database or a bad
change, not a dead card. Copying them off the machine waits for the x64 machine.

## 10. Testing

The scripts are shell. They are checked with `shellcheck` and by running them on
the Pi, not by unit tests. The plan's live checks:

- running `setup-pi.sh` a second time changes nothing;
- the service comes back after `sudo reboot`, and after the power is pulled
  while the Clots are idle;
- each Clot answers a message in the new Discord server;
- an issue opened on Truecast-Build reaches the Truecast Clot through Funnel and
  ends in a pull request from `clots-dot-dev`;
- `npm run deploy` delivers a change without an image rebuild, and one with it;
- the memory and build-time check of parent section 14, with both Clots and three
  workers running;
- a backup archive exists after the timer runs, and its database opens with
  `sqlite3`.

## 11. Done when

Every live check in section 10 has passed on the Pi, and the PC's development
daemon still runs against "Clots (Dev)" as before.

## 12. Risks

- Truecast-Build is a private repository on GitHub's free plan, so GitHub does
  not enforce branch rules on it. Nothing on GitHub's side stops `clots-dot-dev`
  from merging to `main`; only the Clot's own approval rules do.
- Truecast-Build has a second member, `NyxDaDev`, who sees the Clot's issues,
  comments and pull requests, and whose events reach the Clot as an outsider's.
- The microSD card holds the Docker images, the database and the backups, and is
  the single point of failure until the x64 machine.
- Node is held at 26.13.1 and gets no security updates until the script's version
  is changed.
