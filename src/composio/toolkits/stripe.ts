import { z } from "zod";
import type { ToolkitDef } from "./index.js";

/** Composio's Stripe triggers for the kinds of 2c section 8 that it offers, with the Stripe event type each stands for. It has none for `radar.early_fraud_warning.created` or `invoice.overdue`. */
export const STRIPE_EVENT_TYPES: Record<string, string> = {
  STRIPE_INVOICE_PAYMENT_FAILED: "invoice.payment_failed",
  STRIPE_PAYMENT_INTENT_PAYMENT_FAILED: "payment_intent.payment_failed",
  STRIPE_CHARGE_DISPUTE_CREATED: "charge.dispute.created",
  STRIPE_CUSTOMER_SUBSCRIPTION_DELETED: "customer.subscription.deleted",
  STRIPE_PAYOUT_FAILED: "payout.failed",
  STRIPE_CHARGE_REFUNDED: "charge.refunded",
  STRIPE_CHECKOUT_SESSION_COMPLETED: "checkout.session.completed",
};

export const STRIPE = {
  /** Always made. */
  triggers: Object.keys(STRIPE_EVENT_TYPES).filter((slug) => slug !== "STRIPE_CHECKOUT_SESSION_COMPLETED"),
  /** Only with `checkoutCompleted`. */
  checkoutCompleted: "STRIPE_CHECKOUT_SESSION_COMPLETED",
  // Reads: each answers Stripe's own object as `data`.
  retrieveCustomer: "STRIPE_RETRIEVE_CUSTOMER",
  getInvoice: "STRIPE_GET_INVOICES_INVOICE",
  getSubscription: "STRIPE_GET_SUBSCRIPTION",
} as const;

const text = z.string().nullish();
const count = z.number().nullish();
/** A list as Stripe answers it: `{ data: [...] }`. */
const list = z.looseObject({ data: z.array(z.looseObject({})) }).nullish();

export const stripeDef: ToolkitDef = {
  toolkit: "stripe",
  source: "stripe",
  async triggers(a) {
    const slugs: string[] = [...STRIPE.triggers, ...(a.checkoutCompleted ? [STRIPE.checkoutCompleted] : [])];
    return slugs.map((slug) => ({ slug, config: {} }));
  },
  // Stripe's own objects, as `data`. Every Stripe object has an `id`: a missing one means the answer is wrapped or empty.
  responseChecks: {
    [STRIPE.retrieveCustomer]: z.looseObject({ id: z.string().min(1), name: text, email: text, created: count, delinquent: z.boolean().nullish() }),
    [STRIPE.getInvoice]: z.looseObject({ id: z.string().min(1), lines: list, attempt_count: count, next_payment_attempt: count, hosted_invoice_url: text }),
    [STRIPE.getSubscription]: z.looseObject({ id: z.string().min(1), items: list, canceled_at: count, start_date: count }),
  },
};
