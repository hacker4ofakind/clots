"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import { labelOfName } from "@/lib/clots";
import { readableError } from "@/lib/readable-error";
import { DEFAULT_OPTIONS, toolkitName, type Job, type Overview, type Toolkit, type ToolOptions } from "@/lib/integrations";
import { cn } from "@/lib/utils";
import { useAppState } from "../app-state";
import { KeyStep } from "./key-step";
import { OAuthStep } from "./oauth-step";
import { OptionsStep } from "./options-step";
import { PickStep } from "./pick-step";
import { StepFrame } from "./step-frame";
import { WorkingStep } from "./working-step";

type Step = "loading" | "pick" | "options" | "working" | "connect";

export interface IntegrationDialogProps {
  /** The Clot the tool is for (the one being made, in New Clot); absent in Settings, where a tool is shared with every Clot. */
  clot?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The connection is ready: the daemon holds it (or has written it) under this job. `info` says what was connected and with which options. */
  onAdded: (jobId: string, info?: AddedInfo) => void;
  /** A connected tool's id: the dialog opens on its options, and Finish replaces that tool. */
  edit?: string;
  /** A job already under way (Reconnect): the dialog opens on whichever step it is at. */
  resume?: string;
  /** Toolkits already added by the caller (a Clot that does not exist yet), shown as "added". */
  added?: string[];
  /** A job the caller holds for a Clot that does not exist yet: the dialog opens on its options, and Finish runs the same job again. */
  retool?: { jobId: string; toolkit: Toolkit; options: ToolOptions };
}

/** What the dialog tells its caller when a tool is connected. */
export interface AddedInfo {
  toolkit?: Toolkit;
  options: ToolOptions;
}

const message = (e: unknown) => readableError(e, "That could not be done. Try again.");

interface Layout {
  wide: boolean;
  locked: boolean;
}

/**
 * The dialog that connects a Composio tool: pick a toolkit, set its options, wait while the configurer works, then sign in
 * (OAuth) or paste a key. The working and connect steps have no close button and ignore Escape and outside clicks, so a stray
 * click cannot cancel a half-made connection; Back returns to the options.
 */
export function IntegrationDialog(props: IntegrationDialogProps) {
  const { open, onOpenChange, edit, resume } = props;
  const [layout, setLayout] = useState<Layout>({ wide: edit === undefined && resume === undefined, locked: false });
  const leave = useRef<(() => void) | undefined>(undefined);
  const registerLeave = useCallback((fn: (() => void) | undefined) => {
    leave.current = fn;
  }, []);

  // A fresh opening starts at the size of its first step (state adjusted while rendering, so it is right before the first paint).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setLayout({ wide: edit === undefined && resume === undefined, locked: false });
  }

  const change = useCallback(
    (next: boolean) => {
      if (!next) leave.current?.();
      onOpenChange(next);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onEscapeKeyDown={(e) => layout.locked && e.preventDefault()}
        onInteractOutside={(e) => layout.locked && e.preventDefault()}
        className={cn("flex h-140 max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0", layout.wide ? "sm:max-w-155" : "sm:max-w-140")}
      >
        <Flow {...props} close={() => change(false)} registerLeave={registerLeave} onLayout={setLayout} />
      </DialogContent>
    </Dialog>
  );
}

function Flow({ clot: given, edit, resume, added = [], retool, onAdded, onOpenChange, close, registerLeave, onLayout }: IntegrationDialogProps & { close: () => void; registerLeave: (fn: (() => void) | undefined) => void; onLayout: (layout: Layout) => void }) {
  const { subscribe, onResync } = useAppState();
  const [step, setStepState] = useState<Step>(edit !== undefined || resume !== undefined ? "loading" : retool ? "options" : "pick");
  const [toolkit, setToolkit] = useState<Toolkit | undefined>(retool?.toolkit);
  // A tool being edited keeps the scope it has: the Clot it is bound to, if any.
  const [editClot, setEditClot] = useState<string>();
  const clot = given ?? editClot;
  const [options, setOptions] = useState<ToolOptions>(retool?.options ?? DEFAULT_OPTIONS);
  const [job, setJob] = useState<Job>();
  const [kind, setKind] = useState<"oauth" | "key">();
  const [shownAt, setShownAt] = useState(0);
  const [failure, setFailure] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string>();
  const jobId = useRef<string | undefined>(retool?.jobId);
  const stepRef = useRef(step);
  const kindRef = useRef<"oauth" | "key" | undefined>(undefined);
  const finished = useRef(false);
  const restart = useRef(false);
  const callbacks = useRef({ onAdded, onOpenChange });
  const latest = useRef({ toolkit, options });
  useEffect(() => {
    callbacks.current = { onAdded, onOpenChange };
    latest.current = { toolkit, options };
  });

  const go = useCallback((next: Step) => {
    if (next === "connect" && stepRef.current !== "connect") setShownAt(Date.now());
    stepRef.current = next;
    setStepState(next);
  }, []);

  useEffect(() => onLayout({ wide: step === "pick", locked: step === "working" || step === "connect" }), [step, onLayout]);

  const abandon = useCallback(() => {
    // A job the caller holds is not the dialog's to drop: closing the options leaves it as it was.
    if (retool !== undefined) return;
    const id = jobId.current;
    jobId.current = undefined;
    if (id !== undefined && !finished.current) void api(`/integrations/jobs/${id}/abandon`, { method: "POST", body: {} }).catch(() => undefined);
  }, [retool]);
  useEffect(() => {
    registerLeave(abandon);
    return () => registerLeave(undefined);
  }, [registerLeave, abandon]);

  const finish = useCallback(() => {
    if (finished.current || jobId.current === undefined) return;
    finished.current = true;
    if (restart.current) toast("Restart the daemon to finish.");
    callbacks.current.onAdded(jobId.current, { toolkit: latest.current.toolkit, options: latest.current.options });
    callbacks.current.onOpenChange(false);
  }, []);

  /** What the daemon says about the job moves the dialog, unless the user stepped back to the options meanwhile. */
  const applyJob = useCallback(
    (next: Job) => {
      setJob((prev) => ({ ...prev, ...next }));
      if (next.needsRestart) restart.current = true;
      const at = stepRef.current;
      if (at !== "working" && at !== "connect" && at !== "loading") return;
      if (next.state === "failed") {
        setFailure(next.error ?? "The connection could not be made.");
        go("working");
        return;
      }
      setFailure(undefined);
      if (next.state === "working") go("working");
      else if (next.state === "oauth" || next.state === "key") {
        kindRef.current = next.state;
        setKind(next.state);
        go("connect");
      } else if (next.state === "active" && !(at === "connect" && kindRef.current === "oauth")) finish();
    },
    [go, finish],
  );

  useEffect(() => subscribe((event) => event.type === "integration.status" && event.data?.jobId === jobId.current && applyJob(event.data as Job)), [subscribe, applyJob]);
  useEffect(
    () =>
      onResync(() => {
        if (jobId.current !== undefined) void api<Job>(`/integrations/jobs/${jobId.current}`).then(applyJob).catch(() => undefined);
      }),
    [onResync, applyJob],
  );

  // Editing a tool, or picking a job up again: load what is there.
  useEffect(() => {
    if (edit === undefined && resume === undefined) return;
    let live = true;
    void (async () => {
      try {
        const [overview, loaded] = await Promise.all([api<Overview>("/integrations"), resume === undefined ? undefined : api<Job>(`/integrations/jobs/${resume}`)]);
        const tool = edit === undefined ? undefined : overview.tools.find((t) => t.id === edit);
        const slug = tool?.toolkit ?? loaded?.toolkit;
        if (slug === undefined) throw new Error("gone");
        const listed = await api<{ toolkits: Toolkit[] }>(`/integrations/toolkits?q=${encodeURIComponent(slug)}`)
          .then((r) => r.toolkits.find((t) => t.slug === slug))
          .catch(() => undefined);
        if (!live) return;
        setToolkit(listed ?? { slug, name: loaded?.name ?? toolkitName(slug), logo: tool?.logo, auth: "oauth" });
        if (tool?.clot) setEditClot(tool.clot);
        if (tool) setOptions({ audience: tool.audience, selfIsUser: tool.selfIsUser ?? true, shared: tool.shared, events: tool.events ?? true, pollMinutes: tool.pollMinutes ?? 30 });
        if (loaded) {
          jobId.current = loaded.jobId;
          applyJob(loaded);
        } else go("options");
      } catch {
        if (!live) return;
        toast("That tool could not be found.");
        callbacks.current.onOpenChange(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [edit, resume, applyJob, go]);

  const configure = async () => {
    if (!toolkit) return;
    setFailure(undefined);
    kindRef.current = undefined;
    setKind(undefined);
    go("working");
    const polls = options.events && toolkit.webhooks !== true;
    try {
      const res = await api<{ jobId: string }>("/integrations/configure", {
        method: "POST",
        body: {
          toolkit: toolkit.slug,
          ...(clot !== undefined && !options.shared ? { clot } : {}),
          audience: options.audience,
          selfIsUser: options.selfIsUser,
          events: options.events,
          ...(polls ? { pollMinutes: Math.max(1, options.pollMinutes) } : {}),
          ...(jobId.current === undefined ? {} : { jobId: jobId.current }),
          ...(edit === undefined ? {} : { replaces: edit }),
        },
      });
      jobId.current = res.jobId;
      applyJob(await api<Job>(`/integrations/jobs/${res.jobId}`));
    } catch (e) {
      setFailure(message(e));
    }
  };

  const saveKey = async (value: string) => {
    if (jobId.current === undefined) return;
    setSaving(true);
    setKeyError(undefined);
    try {
      await api(`/integrations/jobs/${jobId.current}/key`, { method: "PUT", body: { value } });
      applyJob(await api<Job>(`/integrations/jobs/${jobId.current}`));
    } catch (e) {
      setKeyError(message(e));
    } finally {
      setSaving(false);
    }
  };

  if (step === "pick") {
    return (
      <PickStep
        clot={clot}
        added={added}
        onPick={(picked) => {
          setToolkit(picked);
          setOptions({ ...DEFAULT_OPTIONS });
          go("options");
        }}
      />
    );
  }
  if (step === "loading" || toolkit === undefined) {
    return (
      <StepFrame title="Configure" closable>
        <div aria-busy className="flex flex-col gap-5 py-3">
          {[48, 40, 56, 36].map((width) => (
            <div key={width} className="flex items-center justify-between">
              <Skeleton className="h-4 bg-muted-strong" style={{ width: `${width * 4}px` }} />
              <Skeleton className="h-6 w-10 rounded-full bg-muted-strong" />
            </div>
          ))}
        </div>
      </StepFrame>
    );
  }
  if (step === "options") {
    return (
      <OptionsStep
        toolkit={toolkit}
        clot={clot === undefined ? undefined : labelOfName(clot)}
        options={options}
        onChange={setOptions}
        editing={edit !== undefined || retool !== undefined}
        onBack={() => {
          if (edit !== undefined || retool !== undefined) return close();
          abandon();
          setJob(undefined);
          go("pick");
        }}
        onFinish={() => void configure()}
      />
    );
  }
  if (step === "working") {
    return (
      <WorkingStep
        toolkit={toolkit}
        error={failure}
        onBack={() => {
          setFailure(undefined);
          go("options");
        }}
        onRetry={() => void configure()}
      />
    );
  }
  return kind === "key" ? (
    <KeyStep toolkit={toolkit} instructions={job?.instructions} saving={saving} error={keyError} onBack={() => go("options")} onDone={(value) => void saveKey(value)} />
  ) : (
    <OAuthStep toolkit={toolkit} link={job?.link} active={job?.state === "active"} needsRestart={job?.needsRestart === true} shownAt={shownAt} readyAt={job?.oauthReadyAt} onBack={() => go("options")} onDone={finish} />
  );
}
