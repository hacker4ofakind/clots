"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CaretRightIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiFailure } from "@/lib/api-client";
import { useIntegrations, type Toolkit, type ToolRow } from "@/lib/integrations";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "../confirm-dialog";
import { ToolLogo } from "../tool-logo";
import { StepFrame } from "./step-frame";

const SKELETON_WIDTHS = ["w-28", "w-20", "w-24", "w-32", "w-20", "w-28", "w-24", "w-32"];
const ROW = "flex h-14 w-full items-center gap-3 rounded-card border bg-card pr-2 pl-2.5 text-left text-body";

/** Step one: Composio's toolkits in two columns, searchable. A toolkit that is already added shows "added" and a remove button. */
export function PickStep({ clot, added, onPick }: { clot?: string; added: string[]; onPick: (toolkit: Toolkit) => void }) {
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ q: string; attempt: number; toolkits?: Toolkit[] }>();
  const [removing, setRemoving] = useState<Toolkit>();
  const { overview, reload } = useIntegrations();

  // The list for what is typed now; until it arrives (or when it cannot), there is no list.
  const q = query.trim();
  const current = result?.q === q && result.attempt === attempt ? result : undefined;
  const toolkits = current?.toolkits;
  const failed = current !== undefined && toolkits === undefined;

  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () => {
        api<{ toolkits: Toolkit[] }>(`/integrations/toolkits${q ? `?q=${encodeURIComponent(q)}` : ""}`)
          .then((res) => live && setResult({ q, attempt, toolkits: res.toolkits }))
          .catch(() => live && setResult({ q, attempt }));
      },
      q === "" ? 0 : 200,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, attempt]);

  // The tools this dialog's scope already has: shared ones, and the ones of its Clot.
  const inScope = useMemo(() => {
    const map = new Map<string, ToolRow[]>();
    for (const tool of overview?.tools ?? []) {
      if (clot !== undefined && !tool.shared && tool.clot !== clot) continue;
      map.set(tool.toolkit, [...(map.get(tool.toolkit) ?? []), tool]);
    }
    return map;
  }, [overview, clot]);

  const isAdded = (toolkit: Toolkit) => added.includes(toolkit.slug) || inScope.has(toolkit.slug);
  // The ones already added come first.
  const sorted = toolkits && [...toolkits].sort((a, b) => Number(isAdded(b)) - Number(isAdded(a)));

  const remove = async (toolkit: Toolkit) => {
    try {
      for (const tool of inScope.get(toolkit.slug) ?? []) await api(`/integrations/tools/${encodeURIComponent(tool.id)}`, { method: "DELETE" });
      toast(`Removed ${toolkit.name}`);
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "The daemon cannot be reached.");
    }
    reload();
  };

  return (
    <StepFrame
      title="Add a tool"
      closable
      header={
        <InputGroup>
          <InputGroupAddon>
            <MagnifyingGlassIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Composio’s toolkits" aria-label="Search Composio’s toolkits" autoComplete="off" />
        </InputGroup>
      }
    >
      <ScrollArea className="-mx-5.5 min-h-0 flex-1">
        <div className="px-5.5 pb-4">
          {failed ? (
            <div className="flex flex-col items-start gap-3 py-2">
              <p role="alert" className="text-body text-primary-ink">
                Composio’s list could not be loaded.
              </p>
              <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : toolkits?.length === 0 ? (
            <p className="py-2 text-body text-muted-foreground">No toolkit matches “{q}”.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-1.5" aria-busy={toolkits === undefined}>
              {sorted?.map((toolkit) => {
                const done = isAdded(toolkit);
                const removable = inScope.has(toolkit.slug);
                return (
                  <li key={toolkit.slug}>
                    {done ? (
                      <div className={ROW}>
                        <ToolLogo toolkit={toolkit.slug} name={toolkit.name} logo={toolkit.logo} />
                        <span className="min-w-0 truncate">
                          {toolkit.name} <span className="text-label font-normal text-muted-foreground">· added</span>
                        </span>
                        {removable ? (
                          <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={`Remove ${toolkit.name}`} onClick={() => setRemoving(toolkit)}>
                            <XIcon />
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      <Button variant="ghost" className={cn(ROW, "justify-start gap-3 border-border px-2.5 font-normal hover:bg-muted")} onClick={() => onPick(toolkit)}>
                        <ToolLogo toolkit={toolkit.slug} name={toolkit.name} logo={toolkit.logo} />
                        <span className="min-w-0 truncate">{toolkit.name}</span>
                        <CaretRightIcon aria-hidden className="mr-1.5 ml-auto text-muted-foreground" />
                      </Button>
                    )}
                  </li>
                );
              }) ??
                SKELETON_WIDTHS.map((width, i) => (
                  <li key={i} aria-hidden className={ROW}>
                    <Skeleton className="size-9 rounded-[9px] bg-muted-strong" />
                    <Skeleton className={cn("h-3 bg-muted-strong", width)} />
                  </li>
                ))}
            </ul>
          )}
        </div>
      </ScrollArea>
      <ConfirmDialog open={removing !== undefined} onOpenChange={(open) => !open && setRemoving(undefined)} title={`Remove ${removing?.name ?? ""}?`} description="The Clots stop using it. You can connect it again later." confirmLabel="Remove" onConfirm={() => removing && void remove(removing)} />
    </StepFrame>
  );
}
