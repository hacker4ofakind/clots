import type { ComposioAccount } from "../../config.js";
import type { ExecResult } from "../api.js";
import { calendarDef } from "./googlecalendar.js";
import { genericDef } from "./generic.js";
import { linearDef } from "./linear.js";
import { notionDef } from "./notion.js";
import { posthogDef } from "./posthog.js";
import { stripeDef } from "./stripe.js";

/** One trigger instance an account should have. `pollingMinutes` is for a polled trigger. */
export interface TriggerWant {
  slug: string;
  config: Record<string, unknown>;
  pollingMinutes?: number;
}

/** What a toolkit's def may use of the Composio component. */
export interface ToolkitHost {
  run(a: ComposioAccount, slug: string, args: Record<string, unknown>): Promise<ExecResult>;
}

/**
 * The single home of what is specific to one toolkit: its trigger set, how to learn who the connection
 * is, and what a connection needs besides a key. Mappers, enrichers, senders and inverses join it in
 * the tasks that build them.
 */
export interface ToolkitDef {
  toolkit: string;
  /** The `source` events and rules name it by. */
  source: string;
  /** The trigger instances an account should have. May read from the service, so it may fail. */
  triggers(a: ComposioAccount, host: ToolkitHost): Promise<TriggerWant[]>;
  /** The connection's own user ID at the service. Throws when it cannot be read. */
  identity?(a: ComposioAccount, host: ToolkitHost): Promise<string>;
  /** Fields the connection needs besides the key. */
  connectExtra?(a: ComposioAccount): Record<string, string>;
}

const BUILT_IN: Record<string, ToolkitDef> = {
  linear: linearDef,
  notion: notionDef,
  stripe: stripeDef,
  googlecalendar: calendarDef,
  posthog: posthogDef,
};

/** The def of a toolkit; one with no built-in def is the generic one. */
export const defFor = (toolkit: string): ToolkitDef => BUILT_IN[toolkit] ?? { ...genericDef, toolkit, source: toolkit };

/** The Composio user of an account. */
export const userOf = (a: Pick<ComposioAccount, "toolkit" | "account">): string => `${a.toolkit}:${a.account}`;
