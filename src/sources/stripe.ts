import { createHmac, timingSafeEqual } from "node:crypto";
import type { StripeAccount } from "../config.js";
import type { Enricher } from "../enrich.js";
import { appendBody, clip } from "../events/body.js";
import type { ClotEvent } from "../events/types.js";
import { jsonBody, storeEvent, type Handler } from "../intake.js";

/** How far a delivery's timestamp may be from the daemon's clock. */
const TOLERANCE_SECONDS = 300;

/** Checks `Stripe-Signature`: `t=<seconds>,v1=<hex>[,v1=<hex>...]`, each an HMAC-SHA256 of `<t>.<raw body>`. */
export function verifyStripe(secret: string, rawBody: Buffer, header: string | undefined, nowMs: number): boolean {
  if (!header) return false;
  const parts = header.split(",").map((part) => {
    const at = part.indexOf("=");
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
  });
  const t = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (t === undefined || !/^\d+$/.test(t) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex"));
  return signatures.some((signature) => {
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** The Stripe event types the Clots react to, and the kind each becomes. */
export const STRIPE_KINDS: Record<string, string> = {
  "invoice.payment_failed": "payment_failed",
  "payment_intent.payment_failed": "payment_failed",
  "charge.dispute.created": "dispute_opened",
  "customer.subscription.deleted": "subscription_canceled",
  "radar.early_fraud_warning.created": "fraud_warning",
  "payout.failed": "payout_failed",
  "charge.refunded": "refunded",
  "invoice.overdue": "invoice_overdue",
  "checkout.session.completed": "checkout_completed",
};

/** Currencies Stripe counts in whole units, not hundredths. */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** "€12.00" from 1200 and "eur". Empty when either is missing. */
function money(amount: unknown, currency: unknown): string {
  if (typeof amount !== "number" || typeof currency !== "string" || currency === "") return "";
  const code = currency.toUpperCase();
  const value = ZERO_DECIMAL.has(code) ? amount : amount / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(value);
  } catch {
    return `${value} ${code}`;
  }
}

/** A Unix time in seconds as a date, "2026-10-16". */
const day = (seconds: unknown): string => (typeof seconds === "number" ? new Date(seconds * 1000).toISOString().slice(0, 10) : "");

/** Where the object is in the Stripe dashboard; the event itself when the object has no page of its own. */
function dashboardUrl(objectType: string, id: string, eventId: string, live: boolean): string {
  const base = `https://dashboard.stripe.com/${live ? "" : "test/"}`;
  const pages: Record<string, string> = { invoice: "invoices", payment_intent: "payments", charge: "payments", dispute: "disputes", subscription: "subscriptions", payout: "payouts", customer: "customers" };
  return pages[objectType] === undefined ? `${base}events/${eventId}` : `${base}${pages[objectType]}/${id}`;
}

/**
 * Turns a Stripe event into the common event, or nothing for a type the Clots do not react
 * to. Every Stripe event is automated; events about one customer are held together.
 */
export function normalizeStripe(account: StripeAccount, payload: unknown, receivedAt: number): ClotEvent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, any>;
  if (typeof p.id !== "string" || typeof p.type !== "string") return undefined;
  const kind = STRIPE_KINDS[p.type];
  if (kind === undefined || (kind === "checkout_completed" && !account.checkoutCompleted)) return undefined;

  const o: Record<string, any> = p.data?.object ?? {};
  const objectType = text(o.object) || p.type.split(".").slice(0, -1).join(".");
  const id = text(o.id);
  const customer = typeof o.customer === "string" ? o.customer : text(o.customer?.id);
  const email = text(o.customer_email) || text(o.receipt_email) || text(o.billing_details?.email) || text(o.customer_details?.email);
  const who = email || customer || "a customer";
  const live = p.livemode === true;

  const amount = money(o.amount_due ?? o.amount_refunded ?? o.amount_total ?? o.amount, o.currency);
  const reason =
    text(o.last_payment_error?.message) ||
    text(o.failure_message) ||
    text(o.reason) ||
    text(o.fraud_type) ||
    text(o.cancellation_details?.reason) ||
    text(o.failure_code);
  const titles: Record<string, string> = {
    payment_failed: `Payment of ${amount} failed for ${who}${reason ? ` (${reason})` : ""}`,
    dispute_opened: `Dispute opened: ${amount}${reason ? ` (${reason})` : ""}`,
    subscription_canceled: `Subscription canceled for ${who}${reason ? ` (${reason.replaceAll("_", " ")})` : ""}`,
    fraud_warning: `Early fraud warning on a payment${reason ? ` (${reason.replaceAll("_", " ")})` : ""}`,
    payout_failed: `Payout of ${amount} failed${reason ? ` (${reason})` : ""}`,
    refunded: `Refund of ${amount} to ${who}`,
    invoice_overdue: `Invoice of ${amount} overdue for ${who}`,
    checkout_completed: `Checkout completed: ${amount} from ${who}`,
  };

  const lines = [
    `Stripe event: ${p.type} (${live ? "live" : "test mode"})`,
    `Object: ${objectType} ${id}`,
    `Customer: ${customer || "none"}${email ? ` (${email})` : ""}`,
    ...(amount ? [`Amount: ${amount}`] : []),
    ...(reason ? [`Reason: ${reason}`] : []),
    ...(o.evidence_details?.due_by ? [`Evidence due: ${day(o.evidence_details.due_by)}`] : []),
    ...(typeof o.attempt_count === "number" ? [`Attempts so far: ${o.attempt_count}`] : []),
    ...(typeof o.charge === "string" ? [`Charge: ${o.charge}`] : []),
    ...(text(o.description) ? [`Description: ${text(o.description)}`] : []),
  ];

  return {
    id: `stripe:${account.account}:${p.id}`,
    source: "stripe",
    account: account.account,
    kind,
    place: account.account,
    actor: email || customer || "stripe",
    title: `${titles[kind]}${live ? "" : " (test mode)"}`,
    body: clip(lines.join("\n")),
    url: dashboardUrl(objectType, id, p.id, live),
    ref: id,
    subject: customer ? `customer:${customer}` : `${objectType}:${id}`,
    automated: true,
    receivedAt,
  };
}

/** One Stripe account's intake path. */
export function stripeHandler(account: StripeAccount, deps: { insertEvent: (event: ClotEvent) => boolean; now: () => number }): Handler {
  return (req) => {
    if (!verifyStripe(account.webhookSecret, req.rawBody, req.headers["stripe-signature"], deps.now())) return { status: 400, text: "bad signature" };
    const payload = jsonBody(req.rawBody);
    if (payload === undefined) return { status: 400, text: "body is not JSON" };
    const event = normalizeStripe(account, payload, deps.now());
    if (!event) return { status: 200, text: "ignored" };
    return storeEvent(event, deps.insertEvent);
  };
}

export const STRIPE_UNREAD = "[More about this from Stripe could not be read.]";

/**
 * Adds what the delivery leaves out, read with the account's restricted key: who the customer
 * is, and what an invoice or a subscription was for.
 */
export function stripeEnricher(accounts: StripeAccount[], fetchFn: typeof fetch = fetch): Enricher {
  return async (event) => {
    const account = accounts.find((candidate) => candidate.account === event.account);
    if (!account) return event;
    const get = async (path: string): Promise<any> => {
      const response = await fetchFn(`https://api.stripe.com/v1/${path}`, { headers: { authorization: `Bearer ${account.apiKey}` } });
      if (!response.ok) throw new Error(`Stripe answered ${response.status}`);
      return response.json();
    };
    const lines: string[] = [];
    try {
      const customer = event.subject.startsWith("customer:") ? event.subject.slice("customer:".length) : "";
      if (customer !== "") {
        const c = await get(`customers/${customer}`);
        lines.push(`Customer: ${text(c.name) || "(no name)"} <${text(c.email) || "no email"}>, a customer since ${day(c.created)}${c.delinquent ? "; marked delinquent" : ""}`);
      }
      if (event.ref.startsWith("in_")) {
        const invoice = await get(`invoices/${event.ref}?expand%5B%5D=lines.data.price.product`);
        const products = (invoice.lines?.data ?? []).map((line: any) => text(line.price?.product?.name) || text(line.description)).filter(Boolean);
        if (products.length > 0) lines.push(`Products: ${[...new Set(products)].join(", ")}`);
        const next = invoice.next_payment_attempt ? `; next attempt ${day(invoice.next_payment_attempt)}` : "";
        lines.push(`Invoice: ${text(invoice.hosted_invoice_url) || event.url} (attempt ${invoice.attempt_count ?? "?"}${next})`);
      }
      if (event.ref.startsWith("sub_")) {
        const subscription = await get(`subscriptions/${event.ref}?expand%5B%5D=items.data.price.product`);
        const products = (subscription.items?.data ?? []).map((item: any) => text(item.price?.product?.name)).filter(Boolean);
        if (products.length > 0) lines.push(`Products: ${[...new Set(products)].join(", ")}`);
        if (subscription.canceled_at) lines.push(`Canceled on ${day(subscription.canceled_at)}, started ${day(subscription.start_date)}`);
      }
    } catch {
      return appendBody(event, [...lines, STRIPE_UNREAD].join("\n"));
    }
    return appendBody(event, lines.length === 0 ? "" : `From Stripe:\n${lines.join("\n")}`);
  };
}
