import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StripeAccount } from "../src/config.js";
import type { ClotEvent } from "../src/events/types.js";
import { normalizeStripe, STRIPE_KINDS, stripeEnricher, stripeHandler, verifyStripe } from "../src/sources/stripe.js";

const account: StripeAccount = { account: "shop", clot: "shop", shared: false, webhookSecret: "whsec_test", apiKey: "rk_test", checkoutCompleted: false };
const NOW = 1_760_000_000_000;

function signed(body: string, secret = account.webhookSecret, at = Math.floor(NOW / 1000)): string {
  return `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}

const failedInvoice = {
  id: "evt_1",
  type: "invoice.payment_failed",
  livemode: false,
  data: { object: { id: "in_1", object: "invoice", customer: "cus_1", customer_email: "jane@example.com", amount_due: 1200, currency: "eur", attempt_count: 2, description: null } },
};

describe("verifyStripe", () => {
  const body = JSON.stringify(failedInvoice);

  it("accepts a signature made with the secret over the timestamp and the raw body", () => {
    expect(verifyStripe(account.webhookSecret, Buffer.from(body), signed(body), NOW)).toBe(true);
    // Stripe may send several signatures while a secret is being rolled; one must match.
    expect(verifyStripe(account.webhookSecret, Buffer.from(body), `${signed(body, "whsec_old")},v1=${signed(body).split("v1=")[1]}`, NOW)).toBe(true);
  });

  it("refuses another secret, another body, a missing header and an old timestamp", () => {
    expect(verifyStripe(account.webhookSecret, Buffer.from(body), signed(body, "whsec_other"), NOW)).toBe(false);
    expect(verifyStripe(account.webhookSecret, Buffer.from(`${body} `), signed(body), NOW)).toBe(false);
    expect(verifyStripe(account.webhookSecret, Buffer.from(body), undefined, NOW)).toBe(false);
    expect(verifyStripe(account.webhookSecret, Buffer.from(body), signed(body, account.webhookSecret, Math.floor(NOW / 1000) - 301), NOW)).toBe(false);
  });
});

describe("normalizeStripe", () => {
  it("turns a failed invoice into an automated event about its customer", () => {
    expect(normalizeStripe(account, failedInvoice, NOW)).toMatchObject({
      id: "stripe:shop:evt_1",
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
      receivedAt: NOW,
    });
  });

  it("names the kind for each event type it takes, and ignores the rest", () => {
    expect(Object.values(STRIPE_KINDS).sort()).toEqual(["checkout_completed", "dispute_opened", "fraud_warning", "invoice_overdue", "payment_failed", "payment_failed", "payout_failed", "refunded", "subscription_canceled"]);
    expect(normalizeStripe(account, { ...failedInvoice, type: "customer.created" }, NOW)).toBeUndefined();
    expect(normalizeStripe(account, { nonsense: true }, NOW)).toBeUndefined();
  });

  it("takes completed checkouts only when the account asks for them", () => {
    const checkout = { id: "evt_2", type: "checkout.session.completed", livemode: true, data: { object: { id: "cs_1", object: "checkout.session", customer: null, customer_details: { email: "a@b.c" }, amount_total: 500, currency: "usd" } } };
    expect(normalizeStripe(account, checkout, NOW)).toBeUndefined();
    expect(normalizeStripe({ ...account, checkoutCompleted: true }, checkout, NOW)).toMatchObject({ kind: "checkout_completed", title: "Checkout completed: $5.00 from a@b.c", subject: "checkout.session:cs_1" });
  });

  it("puts what matters for each kind in the title and the body", () => {
    const dispute = { id: "evt_3", type: "charge.dispute.created", livemode: true, data: { object: { id: "dp_1", object: "dispute", charge: "ch_1", amount: 3000, currency: "gbp", reason: "fraudulent", evidence_details: { due_by: 1_760_600_000 } } } };
    const event = normalizeStripe(account, dispute, NOW)!;
    expect(event.title).toBe("Dispute opened: £30.00 (fraudulent)");
    expect(event.body).toContain("Evidence due: 2025-10-16");
    expect(event.url).toBe("https://dashboard.stripe.com/disputes/dp_1");

    const payout = { id: "evt_4", type: "payout.failed", livemode: true, data: { object: { id: "po_1", object: "payout", amount: 10000, currency: "jpy", failure_message: "The bank account has been closed." } } };
    expect(normalizeStripe(account, payout, NOW)).toMatchObject({ title: "Payout of ¥10,000 failed (The bank account has been closed.)", actor: "stripe", subject: "payout:po_1" });
  });
});

describe("stripeHandler", () => {
  it("refuses a bad signature, stores a new event once, and ignores what the Clots do not react to", async () => {
    const seen = new Set<string>();
    const handler = stripeHandler(account, { insertEvent: (e: ClotEvent) => (seen.has(e.id) ? false : (seen.add(e.id), true)), now: () => NOW });
    const body = JSON.stringify(failedInvoice);
    const req = (raw: string, signature?: string) => ({ method: "POST", headers: (signature ? { "stripe-signature": signature } : {}) as Record<string, string>, query: new URLSearchParams(), rawBody: Buffer.from(raw) });
    expect((await handler(req(body))).status).toBe(400);
    expect(await handler(req(body, signed(body)))).toMatchObject({ status: 202, event: { id: "stripe:shop:evt_1" } });
    expect((await handler(req(body, signed(body)))).text).toBe("duplicate");
    const other = JSON.stringify({ ...failedInvoice, id: "evt_9", type: "customer.created" });
    expect((await handler(req(other, signed(other)))).text).toBe("ignored");
  });
});

describe("stripeEnricher", () => {
  it("adds the customer and the invoice's products, read with the restricted key", async () => {
    const calls: { url: string; auth: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: String((init.headers as Record<string, string>).authorization) });
      if (url.includes("/customers/cus_1")) return Response.json({ id: "cus_1", name: "Jane Doe", email: "jane@example.com", created: 1_700_000_000 });
      if (url.includes("/invoices/in_1")) return Response.json({ id: "in_1", hosted_invoice_url: "https://invoice.stripe.com/i/1", attempt_count: 2, next_payment_attempt: 1_760_100_000, lines: { data: [{ description: "Pro plan", price: { product: { name: "Pro" } } }] } });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const event = normalizeStripe(account, failedInvoice, NOW)!;
    const read = await stripeEnricher([account], fetchFn)(event);
    expect(calls.every((c) => c.auth === "Bearer rk_test")).toBe(true);
    expect(read.body).toContain("Customer: Jane Doe <jane@example.com>, a customer since 2023-11-14");
    expect(read.body).toContain("Products: Pro");
    expect(read.body).toContain("Invoice: https://invoice.stripe.com/i/1 (attempt 2; next attempt 2025-10-10)");
  });

  it("says so when Stripe cannot be read", async () => {
    const fetchFn = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const read = await stripeEnricher([account], fetchFn)(normalizeStripe(account, failedInvoice, NOW)!);
    expect(read.body).toContain("[More about this from Stripe could not be read.]");
  });
});

describe("recorded Stripe deliveries", () => {
  const dir = "tests/fixtures/stripe";
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

  it.skipIf(files.length === 0)("turn into an event or are ignored, by their type", () => {
    for (const file of files) {
      const recording = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const event = normalizeStripe({ ...account, checkoutCompleted: true }, recording.body, NOW);
      const kind = STRIPE_KINDS[recording.body.type];
      if (kind === undefined) {
        expect(event, file).toBeUndefined();
        continue;
      }
      expect(event, file).toMatchObject({ source: "stripe", kind, automated: true });
      expect(event!.title.length, file).toBeGreaterThan(10);
      expect(event!.subject, file).toMatch(/^[a-z_.]+:.+/);
    }
  });
});
