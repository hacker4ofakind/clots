/**
 * What each built-in source produces. Sources share a kind where it means the same thing: an issue
 * opened on GitHub and on Linear are both `issue_opened`, told apart by the event's source.
 */
export const SOURCE_KINDS = {
  github: ["issue_opened", "comment", "review", "pr_opened", "ci_failed"],
  linear: ["issue_opened", "comment"],
  notion: ["page_created", "comment"],
  stripe: ["payment_failed", "dispute_opened", "subscription_canceled", "fraud_warning", "payout_failed", "refunded", "invoice_overdue", "checkout_completed"],
  email: ["email"],
  calendar: ["reminder"],
  sentry: ["error_alert", "error_new"],
  vercel: ["deploy_failed"],
  posthog: ["analytics_event"],
  // What the periodic read of the claude.ai connectors found.
  sweep: ["finding"],
  // A Composio toolkit with no source of its own (slack, say) is a source under its slug, not listed here, and produces `trigger` events.
} as const satisfies Record<string, readonly string[]>;

export type BuiltinSource = keyof typeof SOURCE_KINDS;

export const BUILTIN_SOURCES = Object.keys(SOURCE_KINDS) as BuiltinSource[];

export function isBuiltinSource(name: string): name is BuiltinSource {
  return Object.hasOwn(SOURCE_KINDS, name);
}

/** What a watch recipe reports. */
export const WATCH_KINDS = ["item_added", "item_changed"] as const;

/** A kind a rule or a webhook recipe may name: lowercase letters, digits and underscores. `batch` is the daemon's own. */
export const KIND_PATTERN = /^[a-z][a-z0-9_]*$/;
