import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Composio } from "../src/composio/component.js";
import { STRIPE, STRIPE_EVENT_TYPES } from "../src/composio/toolkits/stripe.js";
import type { StripeAccount } from "../src/config.js";
import { Supervisor } from "../src/listeners.js";
import { normalizeStripe, STRIPE_KINDS, STRIPE_UNREAD, stripeEnricher, stripeMapper } from "../src/sources/stripe.js";
import { Store } from "../src/store.js";
import { FakeComposioApi } from "./fake-composio.js";

const account: StripeAccount = { toolkit: "stripe", account: "shop", clot: "shop", shared: false, audience: "public", apiKey: "rk_test", apiKeyName: "K", checkoutCompleted: false, triggers: [] };
const NOW = 1_760_000_000_000;

const failedInvoice = { id: "in_1", object: "invoice", livemode: false, customer: "cus_1", customer_email: "jane@example.com", amount_due: 1200, currency: "eur", attempt_count: 2, description: null };

describe("normalizeStripe", () => {
  it("turns a failed invoice into an automated event about its customer", () => {
    expect(normalizeStripe(account, "invoice.payment_failed", failedInvoice, NOW)).toMatchObject({
      id: "stripe:shop:invoice.payment_failed:in_1:2",
      source: "stripe",
      account: "shop",
      kind: "payment_failed",
      place: "shop",
      actor: "jane@example.com",
      title: "Payment of €12.00 failed for jane@example.com (test mode)",
      url: "https://dashboard.stripe.com/test/invoices/in_1",
      ref: "in_1",
      subject: "customer:cus_1",
      automated: true,
      outsider: true,
      receivedAt: NOW,
    });
  });

  it("names the kind for each event type it takes, and ignores the rest", () => {
    expect(Object.values(STRIPE_KINDS).sort()).toEqual(["checkout_completed", "dispute_opened", "payment_failed", "payment_failed", "payout_failed", "refunded", "subscription_canceled"]);
    // Every trigger Composio is asked for has a kind.
    for (const type of Object.values(STRIPE_EVENT_TYPES)) expect(STRIPE_KINDS[type], type).toBeDefined();
    expect(normalizeStripe(account, "customer.created", failedInvoice, NOW)).toBeUndefined();
    expect(normalizeStripe(account, "invoice.payment_failed", { object: "invoice" }, NOW)).toBeUndefined();
  });

  it("takes completed checkouts only when the account asks for them", () => {
    const checkout = { id: "cs_1", object: "checkout.session", livemode: true, customer: null, customer_details: { email: "a@b.c" }, amount_total: 500, currency: "usd" };
    expect(normalizeStripe(account, "checkout.session.completed", checkout, NOW)).toBeUndefined();
    expect(normalizeStripe({ ...account, checkoutCompleted: true }, "checkout.session.completed", checkout, NOW)).toMatchObject({ kind: "checkout_completed", title: "Checkout completed: $5.00 from a@b.c", subject: "checkout.session:cs_1" });
  });

  it("puts what matters for each kind in the title and the body", () => {
    const dispute = { id: "dp_1", object: "dispute", livemode: true, charge: "ch_1", amount: 3000, currency: "gbp", reason: "fraudulent", evidence_details: { due_by: 1_760_600_000 } };
    const event = normalizeStripe(account, "charge.dispute.created", dispute, NOW)!;
    expect(event.title).toBe("Dispute opened: £30.00 (fraudulent)");
    expect(event.body).toContain("Evidence due: 2025-10-16");
    expect(event.url).toBe("https://dashboard.stripe.com/disputes/dp_1");

    const payout = { id: "po_1", object: "payout", livemode: true, amount: 10000, currency: "jpy", failure_message: "The bank account has been closed." };
    expect(normalizeStripe(account, "payout.failed", payout, NOW)).toMatchObject({ title: "Payout of ¥10,000 failed (The bank account has been closed.)", actor: "stripe", subject: "payout:po_1" });
  });

  it("keeps a retried delivery one event, and a second attempt another", () => {
    const first = normalizeStripe(account, "invoice.payment_failed", failedInvoice, NOW)!;
    expect(normalizeStripe(account, "invoice.payment_failed", failedInvoice, NOW + 5000)!.id).toBe(first.id);
    expect(normalizeStripe(account, "invoice.payment_failed", { ...failedInvoice, attempt_count: 3 }, NOW)!.id).not.toBe(first.id);
  });
});

describe("stripeMapper", () => {
  it("maps a trigger by its slug, with no actor and no objects of the Clots' to match", () => {
    const mapped = stripeMapper(account, "STRIPE_INVOICE_PAYMENT_FAILED", failedInvoice, "msg_1", NOW)!;
    expect(mapped.event.kind).toBe("payment_failed");
    expect(mapped.actorId).toBe("");
    expect(stripeMapper(account, "STRIPE_CUSTOMER_CREATED", failedInvoice, "msg_1", NOW)).toBeUndefined();
    expect(stripeMapper(account, "STRIPE_INVOICE_PAYMENT_FAILED", "junk", "msg_1", NOW)).toBeUndefined();
  });
});

describe("stripeEnricher", () => {
  let api: FakeComposioApi;
  let composio: Composio;
  beforeEach(async () => {
    api = new FakeComposioApi();
    composio = new Composio({ api, store: new Store(":memory:"), accounts: [account], publicUrl: "https://x.example", tell: async () => {}, tellHome: async () => {}, now: () => NOW, schedule: () => () => {}, supervisor: new Supervisor({ schedule: () => () => {} }), log: () => {} });
    await composio.reconcile();
  });

  it("adds the customer and the invoice's products, read through Composio with the restricted key", async () => {
    api.answers.set(STRIPE.retrieveCustomer, { ok: true, data: { id: "cus_1", name: "Jane Doe", email: "jane@example.com", created: 1_700_000_000 } });
    api.answers.set(STRIPE.getInvoice, { ok: true, data: { id: "in_1", hosted_invoice_url: "https://invoice.stripe.com/i/1", attempt_count: 2, next_payment_attempt: 1_760_100_000, lines: { data: [{ description: "Pro plan", price: { product: { name: "Pro" } } }] } } });
    const event = normalizeStripe(account, "invoice.payment_failed", failedInvoice, NOW)!;
    const read = await stripeEnricher(composio)(event);
    expect(read.body).toContain("Customer: Jane Doe <jane@example.com>, a customer since 2023-11-14");
    expect(read.body).toContain("Products: Pro");
    expect(read.body).toContain("Invoice: https://invoice.stripe.com/i/1 (attempt 2; next attempt 2025-10-10)");
    expect(api.of("execute").every((c) => c.startsWith("execute:stripe:shop "))).toBe(true);
    expect(api.of("execute").some((c) => c.includes('"expand":["lines.data.price.product"]'))).toBe(true);
  });

  it("says so when Stripe cannot be read", async () => {
    api.answers.set(STRIPE.retrieveCustomer, { ok: false, error: "offline", reason: "unreachable" });
    const read = await stripeEnricher(composio)(normalizeStripe(account, "invoice.payment_failed", failedInvoice, NOW)!);
    expect(read.body).toContain(STRIPE_UNREAD);
  });
});

describe("recorded Stripe deliveries", () => {
  const dir = "tests/fixtures/composio/stripe";
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

  it.skipIf(files.length === 0)("turn into an event by their trigger", () => {
    for (const file of files) {
      const recording = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const slug = recording.body.metadata.trigger_slug;
      const mapped = stripeMapper({ ...account, checkoutCompleted: true }, slug, recording.body.data, recording.body.id, NOW);
      // A customer writes what a Stripe event carries.
      expect(mapped?.event, file).toMatchObject({ source: "stripe", kind: STRIPE_KINDS[STRIPE_EVENT_TYPES[slug]], automated: true, outsider: true });
      expect(mapped!.event.title.length, file).toBeGreaterThan(10);
      expect(mapped!.event.subject, file).toMatch(/^[a-z_.]+:.+/);
    }
  });
});
