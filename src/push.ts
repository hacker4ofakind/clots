import type Database from "better-sqlite3";
import { generateVAPIDKeys, sendNotification, setVapidDetails } from "web-push";
import type { AskSnapshot } from "./asks.js";

/** Push services a subscription may point at. Anything else is refused, so a subscription cannot make the daemon call an arbitrary address. */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

export function allowedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** One subscription per device. */
export class PushStore {
  constructor(private db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)");
  }
  add(sub: Subscription, now: number): void {
    this.db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth").run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, now);
  }
  remove(endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }
  all(): Subscription[] {
    return (this.db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at").all() as any[]).map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
  }
}

export interface Notification {
  title: string;
  body: string;
  /** A same-origin path the tap opens. */
  url: string;
  /** Replaces an earlier notification with the same tag. */
  tag: string;
}

export interface PushDeps {
  store: PushStore;
  /** Sends one notification; the status is the push service's. */
  send: (sub: Subscription, payload: string) => Promise<{ status: number }>;
  now: () => number;
  /** How long a device that reported itself visible counts as someone looking. */
  attentionMs?: number;
}

/**
 * Push notifications to the devices that installed the app. A send that the push service answers with 404 or 410 deletes
 * that subscription. "Someone is looking" means a device reported itself visible within the last two minutes, so a desktop
 * tab left open at home does not keep the phone from hearing a reply.
 */
export class Push {
  private seen = new Map<string, number>();
  private urgentSent = new Set<number>();

  constructor(private d: PushDeps) {}

  /** A device says whether its tab or app is visible. */
  report(clientId: string, visible: boolean): void {
    if (visible) this.seen.set(clientId, this.d.now());
    else this.seen.delete(clientId);
  }

  /** Whether a device has been visible and in use lately. */
  attended(): boolean {
    const window = this.d.attentionMs ?? 120_000;
    for (const [id, at] of this.seen) {
      if (this.d.now() - at > window) this.seen.delete(id);
    }
    return this.seen.size > 0;
  }

  async notify(n: Notification): Promise<number> {
    let sent = 0;
    for (const sub of this.d.store.all()) {
      try {
        const res = await this.d.send(sub, JSON.stringify(n));
        if (res.status === 404 || res.status === 410) this.d.store.remove(sub.endpoint);
        else if (res.status < 300) sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) this.d.store.remove(sub.endpoint);
        else console.warn("[push] a send failed:", error instanceof Error ? error.message : error);
      }
    }
    return sent;
  }

  /** The ask's one line, for the body of its notification. */
  private askNote(ask: Pick<AskSnapshot, "clot" | "id" | "summary">, tag: string, prefix = ""): Notification {
    return { title: ask.clot, body: `${prefix}${ask.summary}`, url: `/c/${encodeURIComponent(ask.clot)}?ask=${ask.id}`, tag };
  }

  askOpened(ask: AskSnapshot): Promise<number> {
    return this.notify(this.askNote(ask, `ask-${ask.id}`));
  }

  /** An ask entering its last minute: once. */
  askUrgent(ask: AskSnapshot): Promise<number> {
    if (this.urgentSent.has(ask.id)) return Promise.resolve(0);
    this.urgentSent.add(ask.id);
    return this.notify(this.askNote(ask, `ask-${ask.id}`, "Less than a minute left: "));
  }

  /** A choice the timeout decided. */
  choiceDecided(clot: string, id: number, outcome: string): Promise<number> {
    return this.notify({ title: clot, body: outcome, url: `/c/${encodeURIComponent(clot)}`, tag: `ask-${id}` });
  }

  /**
   * The one place that decides which daemon events reach the phone. The phone is for what waits on the user: an ask
   * (a permission, a rule, a merge, an email, ...), a choice and its timeout decision. A Clot finishing a turn, replying,
   * pausing or failing is not in this list, so it stays quiet. A new reason to ping goes here, one line each.
   */
  onEvent(event: { type: string; data: unknown }): Promise<number> | null {
    const d = event.data as any;
    switch (event.type) {
      case "ask.opened":
        return this.askOpened(d);
      case "ask.updated":
        return d.timer === "urgent" ? this.askUrgent(d) : null;
      case "ask.closed":
        return d.kind === "choice" && d.result === "timed_out" ? this.choiceDecided(d.clot, d.id, d.outcome) : null;
      default:
        return null;
    }
  }
}

/** The sender that talks to the push services, with the daemon's VAPID keys. */
export function webPushSender(vapid: { publicKey: string; privateKey: string; subject: string }): PushDeps["send"] {
  setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return async (sub, payload) => {
    const res = await sendNotification(sub, payload, { TTL: 3600 });
    return { status: res.statusCode };
  };
}

export const newVapidKeys = () => generateVAPIDKeys();
