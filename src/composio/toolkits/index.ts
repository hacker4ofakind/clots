import type { ZodType } from "zod";
import type { ComposioAccount } from "../../config.js";
import type { ComposioRecipe } from "../../rulebook.js";
import type { ExecResult, ToolInfo } from "../api.js";
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
  /** `run`, then the answer is checked against the shape the daemon relies on; a mismatch is a failed result and is noted as drift. */
  runChecked(a: ComposioAccount, slug: string, args: Record<string, unknown>, check?: ZodType): Promise<ExecResult>;
  /** The Composio recipe in force for a toolkit, if any (the generic def reads its `identity`). */
  recipe(toolkit: string): ComposioRecipe | undefined;
  tool(slug: string): Promise<ToolInfo | undefined>;
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
  /** The connection's own user ID at the service. Throws when it cannot be read; undefined when the toolkit has no way to say. */
  identity?(a: ComposioAccount, host: ToolkitHost): Promise<string | undefined>;
  /** Fields the connection needs besides the key. */
  connectExtra?(a: ComposioAccount): Record<string, string>;
  /**
   * The shape of what each fixed-purpose call of the daemon relies on, by tool slug (enrichment reads,
   * identity, the calendar's calls). `runChecked` applies it; a call that is not here is not checked.
   */
  responseChecks?: Record<string, ZodType>;
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
