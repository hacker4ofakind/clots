"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowCounterClockwiseIcon, ArrowSquareOutIcon, CheckIcon, CircleIcon, CheckCircleIcon, CopyIcon } from "@phosphor-icons/react";
import type { MessageView } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useAppState } from "./app-state";

interface Step {
  id: string;
  done: boolean;
  detail: string;
}

const TITLES: Record<string, string> = { webhook: "Add the GitHub webhook", tools: "Connect the tools it needs", "push-branch": "Let it push a branch" };

/** A read-only value with a Copy button. The value is fetched when Copy is pressed if `load` is given, so a secret is never on the page. */
function CopyField({ label, value, load, masked }: { label: string; value?: string; load?: () => Promise<string>; masked?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(load ? await load() : (value ?? ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Could not copy. Select the text and copy it by hand.");
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-label text-foreground-soft">{label}</span>
      <InputGroup>
        <InputGroupInput readOnly aria-label={label} value={masked ? "••••••••••••••••" : (value ?? "")} className="font-mono text-code md:text-code" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label={`Copy the ${label.toLowerCase()}`} onClick={() => void copy()}>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

/**
 * A new Clot's first message: one line, and its setup as a checklist that ticks itself as each step is done. The webhook step shows
 * the address to send to and the secret behind a Copy button; the daemon gives the secret only when it is pressed.
 */
export function OnboardingCard({ message }: { message: MessageView }) {
  const { subscribe, onResync } = useAppState();
  const data = (message.data ?? {}) as { repo?: string; webhookUrl?: string };
  const [steps, setSteps] = useState<Step[]>();
  const load = useCallback(async () => {
    try {
      setSteps((await api<{ items: Step[] }>(`/clots/${encodeURIComponent(message.clot)}/onboarding`)).items);
    } catch {
      // The next tick or event tries again.
    }
  }, [message.clot]);

  // Unticks the webhook step and shows its instructions again, for a webhook that was deleted on GitHub.
  const redoWebhook = async () => {
    try {
      setSteps((await api<{ items: Step[] }>(`/clots/${encodeURIComponent(message.clot)}/onboarding/webhook/reset`, { method: "POST" })).items);
    } catch {
      toast("Could not redo the step. Try again.");
    }
  };

  const allDone = steps?.every((s) => s.done) === true;
  useEffect(() => {
    void load();
    if (allDone) return;
    // GitHub's ping reaches the daemon without any event the page hears, so a step that is still open is asked about every few seconds
    // (a page in the background too), and at once when the page comes back.
    const timer = setInterval(() => void load(), 4000);
    const back = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [load, allDone]);
  useEffect(() => onResync(() => void load()), [onResync, load]);
  useEffect(() => subscribe((e) => (e.type === "integration.status" || e.type === "workers.updated" || e.type === "clot.state") && void load()), [subscribe, load]);

  return (
    <div className="flex flex-col gap-3" data-onboarding>
      <p className="text-chat">{message.text}</p>
      <Card size="flush" className="gap-0 py-0">
        <ol className="flex flex-col" aria-busy={steps === undefined}>
          {steps === undefined
            ? [0, 1, 2].map((i) => (
                <li key={i} className="flex items-start gap-3 px-4 py-3.5 not-first:border-t">
                  <Skeleton className="mt-0.5 size-5 shrink-0 rounded-full" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3.5 w-72 max-w-full" />
                  </div>
                </li>
              ))
            : null}
          {(steps ?? []).map((step, i) => (
            <li key={step.id} data-step={step.id} data-done={step.done} className="flex flex-col gap-3 px-4 py-3.5 not-first:border-t">
              <div className="flex items-start gap-3">
                {step.done ? <CheckCircleIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-highlight-ink" aria-label="Done" /> : <CircleIcon size={20} className="mt-0.5 shrink-0 text-muted-foreground" aria-label="Not done yet" />}
                <div className="min-w-0 flex-1">
                  <p className={cn("text-body font-medium", step.done && "text-muted-foreground")}>
                    {i + 1}. {TITLES[step.id] ?? step.id}
                  </p>
                  <p className="text-label font-normal text-muted-foreground">{step.detail}</p>
                </div>
                {step.id === "webhook" && step.done ? (
                  <Button variant="ghost" size="icon-sm" className="-my-1 -mr-2 shrink-0 text-muted-foreground" aria-label="Redo the webhook step" title="Redo this step" onClick={() => void redoWebhook()}>
                    <ArrowCounterClockwiseIcon />
                  </Button>
                ) : null}
                {step.id === "tools" && !step.done ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/settings/integrations">Open integrations</Link>
                  </Button>
                ) : null}
              </div>
              {step.id === "webhook" && !step.done && data.webhookUrl ? (
                <div className="ml-8 flex flex-col gap-3">
                  {data.repo ? (
                    <Button asChild variant="outline" size="sm" className="w-fit">
                      <a href={`https://github.com/${data.repo}/settings/hooks/new`} target="_blank" rel="noopener noreferrer">
                        Open the webhook form <ArrowSquareOutIcon />
                      </a>
                    </Button>
                  ) : null}
                  <p className="text-label font-normal text-muted-foreground">Set the content type to application/json and send everything.</p>
                  <CopyField label="Payload URL" value={data.webhookUrl} />
                  <CopyField label="Secret" masked load={async () => (await api<{ secret: string }>(`/clots/${encodeURIComponent(message.clot)}/webhook-secret`)).secret} />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
