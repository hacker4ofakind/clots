"use client";

import type { ComponentType } from "react";
import { ArrowLeftIcon, GlobeIcon, LockSimpleIcon, UsersThreeIcon, type IconProps } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { parseLeadTimes, type Audience, type Toolkit, type ToolOptions } from "@/lib/integrations";
import { FieldRow } from "../field-row";
import { TimeInput } from "../time-input";
import { ToolLogo } from "../tool-logo";
import { StepFrame } from "./step-frame";

const AUDIENCES: { value: Audience; label: string; icon: ComponentType<IconProps> }[] = [
  { value: "private", label: "Private", icon: LockSimpleIcon },
  { value: "team", label: "Team", icon: UsersThreeIcon },
  { value: "public", label: "Public", icon: GlobeIcon },
];

/**
 * Step two: who can see what the Clot writes there, whether it is the user's own account, whether every Clot uses it, whether
 * events come in, and how often to check when the toolkit cannot push them. The "every Clot" switch only exists when the
 * dialog was opened for a Clot; without one the tool is shared.
 */
export function OptionsStep({
  toolkit,
  clot,
  options,
  onChange,
  onBack,
  onFinish,
  editing,
}: {
  toolkit: Toolkit;
  clot?: string;
  options: ToolOptions;
  onChange: (options: ToolOptions) => void;
  onBack: () => void;
  onFinish: () => void;
  editing: boolean;
}) {
  const set = <K extends keyof ToolOptions>(key: K, value: ToolOptions[K]) => onChange({ ...options, [key]: value });
  const polls = options.events;
  const calendar = toolkit.slug === "googlecalendar";
  const leadError = calendar && parseLeadTimes(options.leadTimes) === undefined ? "Use a number and m, h or d, like 24h or 90m. Separate several with commas." : undefined;
  return (
    <StepFrame
      title={`Configure ${toolkit.name}`}
      logo={<ToolLogo toolkit={toolkit.slug} name={toolkit.name} logo={toolkit.logo} size="sm" />}
      closable
      footer={
        <>
          <Button variant="outline" onClick={onBack}>
            {editing ? null : <ArrowLeftIcon />}
            {editing ? "Cancel" : "Back"}
          </Button>
          <Button data-primary disabled={leadError !== undefined} onClick={onFinish}>Finish</Button>
        </>
      }
    >
      <FieldRow label="Audience" help={`Who can see what ${clot ?? "the Clots"} ${clot ? "writes" : "write"} there`} htmlFor="tool-audience">
        <Select value={options.audience} onValueChange={(value) => set("audience", value as Audience)}>
          <SelectTrigger id="tool-audience" className="w-37.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUDIENCES.map(({ value, label, icon: Icon }) => (
              <SelectItem key={value} value={value}>
                <Icon aria-hidden className="text-muted-foreground" />
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="Is this your own account?" htmlFor="tool-self">
        <Switch id="tool-self" checked={options.selfIsUser} onCheckedChange={(on) => set("selfIsUser", on)} />
      </FieldRow>
      {clot ? (
        <FieldRow label="Share with every Clot" help={`Off: only ${clot} uses it`} htmlFor="tool-shared">
          <Switch id="tool-shared" checked={options.shared} onCheckedChange={(on) => set("shared", on)} />
        </FieldRow>
      ) : null}
      <FieldRow label="Events" htmlFor="tool-events">
        <Switch id="tool-events" checked={options.events} onCheckedChange={(on) => set("events", on)} />
      </FieldRow>
      {polls ? (
        <div className="pl-4">
          <FieldRow label="Check every" help={`Used only if ${toolkit.name} can’t push events`} htmlFor="tool-poll">
            <TimeInput id="tool-poll" label="Check every" value={options.pollMinutes} onChange={(minutes) => set("pollMinutes", minutes)} />
          </FieldRow>
        </div>
      ) : null}
      {calendar ? (
        <FieldRow label="Remind me before events" help="How long ahead each event reminds you. Separate several with commas" htmlFor="tool-lead" error={leadError}>
          <Input id="tool-lead" value={options.leadTimes} onChange={(e) => set("leadTimes", e.target.value)} placeholder="24h, 1h" autoComplete="off" spellCheck={false} aria-invalid={leadError !== undefined} className="w-37.5 font-mono text-code md:text-code" />
        </FieldRow>
      ) : null}
      {toolkit.slug === "stripe" ? (
        <FieldRow label="Include completed checkouts" help={`Also tell ${clot ?? "the Clots"} when a customer finishes paying at checkout`} htmlFor="tool-checkout">
          <Switch id="tool-checkout" checked={options.checkoutCompleted} onCheckedChange={(on) => set("checkoutCompleted", on)} />
        </FieldRow>
      ) : null}
    </StepFrame>
  );
}
