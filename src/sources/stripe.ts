import type { Composio } from "../composio/component.js";
import type { Mapper } from "../composio/intake.js";
import { STRIPE, STRIPE_EVENT_TYPES } from "../composio/toolkits/stripe.js";
import type { StripeAccount } from "../config.js";
import type { Enricher } from "../enrich.js";
import { appendBody, clip } from "../events/body.js";
import type { ClotEvent } from "../events/types.js";

/** The Stripe event types the Clots react to, and the kind each becomes. Composio offers no trigger for a fraud warning or an overdue invoice. */
export const STRIPE_KINDS: Record<string, string> = {
  "invoice.payment_failed": "payment_failed",
  "payment_intent.payment_failed": "payment_failed",
  "charge.dispute.created": "dispute_opened",
  "customer.subscription.deleted": "subscription_canceled",
  "payout.failed": "payout_failed",
  "charge.refunded": "refunded",
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

/** Where the object is in the Stripe dashboard; the object's own page is all there is, since Composio's payload names no event. */
function dashboardUrl(objectType: string, id: string, live: boolean): string {
  const base = `https://dashboard.stripe.com/${live ? "" : "test/"}`;
  const pages: Record<string, string> = { invoice: "invoices", payment_intent: "payments", charge: "payments", dispute: "disputes", subscription: "subscriptions", payout: "payouts", customer: "customers" };
  return pages[objectType] === undefined ? base : `${base}${pages[objectType]}/${id}`;
}

/**
 * Turns the object of a Stripe event (Composio's trigger payload is the object, not the event) into the
 * common event, or nothing for a type the Clots do not react to. Every Stripe event is automated; events
 * about one customer are held together. Composio's payload carries no event ID, so the ID is made of the
 * type, the object and what tells one occurrence from the next (an invoice's attempt count, a refund's
 * total), which keeps a retried delivery one event.
 */
export function normalizeStripe(account: StripeAccount, eventType: string, o: Record<string, any>, receivedAt: number): ClotEvent | undefined {
  const kind = STRIPE_KINDS[eventType];
  if (kind === undefined || (kind === "checkout_completed" && !account.checkoutCompleted)) return undefined;
  const objectType = text(o.object) || eventType.split(".").slice(0, -1).join(".");
  const id = text(o.id);
  if (id === "") return undefined;
  const customer = typeof o.customer === "string" ? o.customer : text(o.customer?.id);
  const email = text(o.customer_email) || text(o.receipt_email) || text(o.billing_details?.email) || text(o.customer_details?.email);
  const who = email || customer || "a customer";
  const live = o.livemode === true;

  const amount = money(o.amount_due ?? o.amount_refunded ?? o.amount_total ?? o.amount, o.currency);
  const reason = text(o.last_payment_error?.message) || text(o.failure_message) || text(o.reason) || text(o.cancellation_details?.reason) || text(o.failure_code);
  const titles: Record<string, string> = {
    payment_failed: `Payment of ${amount} failed for ${who}${reason ? ` (${reason})` : ""}`,
    dispute_opened: `Dispute opened: ${amount}${reason ? ` (${reason})` : ""}`,
    subscription_canceled: `Subscription canceled for ${who}${reason ? ` (${reason.replaceAll("_", " ")})` : ""}`,
    payout_failed: `Payout of ${amount} failed${reason ? ` (${reason})` : ""}`,
    refunded: `Refund of ${amount} to ${who}`,
    checkout_completed: `Checkout completed: ${amount} from ${who}`,
  };

  const lines = [
    `Stripe event: ${eventType} (${live ? "live" : "test mode"})`,
    `Object: ${objectType} ${id}`,
    `Customer: ${customer || "none"}${email ? ` (${email})` : ""}`,
    ...(amount ? [`Amount: ${amount}`] : []),
    ...(reason ? [`Reason: ${reason}`] : []),
    ...(o.evidence_details?.due_by ? [`Evidence due: ${day(o.evidence_details.due_by)}`] : []),
    ...(typeof o.attempt_count === "number" ? [`Attempts so far: ${o.attempt_count}`] : []),
    ...(typeof o.charge === "string" ? [`Charge: ${o.charge}`] : []),
    ...(text(o.description) ? [`Description: ${text(o.description)}`] : []),
  ];
  const occurrence = o.attempt_count ?? o.amount_refunded ?? o.canceled_at ?? o.created ?? "";

  return {
    id: `stripe:${account.account}:${eventType}:${id}:${occurrence}`,
    source: "stripe",
    account: account.account,
    kind,
    place: account.account,
    actor: email || customer || "stripe",
    title: `${titles[kind]}${live ? "" : " (test mode)"}`,
    body: clip(lines.join("\n")),
    url: dashboardUrl(objectType, id, live),
    ref: id,
    subject: customer ? `customer:${customer}` : `${objectType}:${id}`,
    automated: true,
    // A customer writes the description, name and address it carries.
    outsider: true,
    receivedAt,
  };
}

/** The mapper for Composio's Stripe triggers. Stripe has no actor of its own to tell apart. */
export const stripeMapper: Mapper = (account, slug, data, _webhookId, receivedAt) => {
  const type = STRIPE_EVENT_TYPES[slug];
  if (type === undefined || typeof data !== "object" || data === null) return undefined;
  const event = normalizeStripe(account as StripeAccount, type, data as Record<string, any>, receivedAt);
  return event && { event, actorId: "", objectIds: [] };
};

export const STRIPE_UNREAD = "[More about this from Stripe could not be read.]";

/**
 * Adds what the delivery leaves out, read through Composio with the account's restricted key: who the
 * customer is, and what an invoice or a subscription was for.
 */
export function stripeEnricher(c: Composio): Enricher {
  return async (event) => {
    const account = c.account(event.account, "stripe") as StripeAccount | undefined;
    if (!account) return event;
    const read = async (slug: string, args: Record<string, unknown>): Promise<any> => {
      const result = await c.run(account, slug, args);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    };
    const lines: string[] = [];
    try {
      const customer = event.subject.startsWith("customer:") ? event.subject.slice("customer:".length) : "";
      if (customer !== "") {
        const found = await read(STRIPE.retrieveCustomer, { customer_id: customer });
        lines.push(`Customer: ${text(found.name) || "(no name)"} <${text(found.email) || "no email"}>, a customer since ${day(found.created)}${found.delinquent ? "; marked delinquent" : ""}`);
      }
      if (event.ref.startsWith("in_")) {
        const invoice = await read(STRIPE.getInvoice, { invoice: event.ref, expand: ["lines.data.price.product"] });
        const products = (invoice.lines?.data ?? []).map((line: any) => text(line.price?.product?.name) || text(line.description)).filter(Boolean);
        if (products.length > 0) lines.push(`Products: ${[...new Set(products)].join(", ")}`);
        const next = invoice.next_payment_attempt ? `; next attempt ${day(invoice.next_payment_attempt)}` : "";
        lines.push(`Invoice: ${text(invoice.hosted_invoice_url) || event.url} (attempt ${invoice.attempt_count ?? "?"}${next})`);
      }
      if (event.ref.startsWith("sub_")) {
        const subscription = await read(STRIPE.getSubscription, { subscription_id: event.ref });
        const products = (subscription.items?.data ?? []).map((item: any) => text(item.price?.product?.name) || text(item.price?.nickname) || text(item.plan?.nickname)).filter(Boolean);
        if (products.length > 0) lines.push(`Products: ${[...new Set(products)].join(", ")}`);
        if (subscription.canceled_at) lines.push(`Canceled on ${day(subscription.canceled_at)}, started ${day(subscription.start_date)}`);
      }
    } catch {
      return appendBody(event, [...lines, STRIPE_UNREAD].join("\n"));
    }
    return appendBody(event, lines.length === 0 ? "" : `From Stripe:\n${lines.join("\n")}`);
  };
}
