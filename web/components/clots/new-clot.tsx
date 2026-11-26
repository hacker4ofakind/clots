"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import { ArrowCounterClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, GithubLogoIcon } from "@phosphor-icons/react";
import type { ClotIcon as ClotIconValue, MessagePage } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiFailure } from "@/lib/api-client";
import { readableError } from "@/lib/readable-error";
import { useAppState } from "./app-state";
import { BuildProgress } from "./build-progress";
import { ClotIcon } from "./clot-icon";
import { IconPicker } from "./icon-picker";
import { IconTile } from "./icon-tile";
import { DEFAULT_ICON, STEPS, iconFromParam, iconToParam, recalledHeld, rememberHeld, sameName, type Build, type HeldTool, type Step } from "./new-clot-state";
import { ToolsStep } from "./new-clot-tools";

type Errors = { name?: string; repo?: string };
type Invite = { login?: string };

const parseStep = (value: string | null): Step => (STEPS.includes(value as Step) ? (value as Step) : "details");
const enc = encodeURIComponent;

/** A field's label in the label type style (the shadcn label's own size and weight would win without the marks). */
function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: string }) {
  return (
    <Label htmlFor={htmlFor} className="text-label! leading-normal! font-semibold! text-foreground-soft">
      {children}
    </Label>
  );
}

/** The errors a failed create or edit carried, as the form's fields. */
function fieldErrors(e: unknown): { errors: Errors & { toolJobs?: string }; text?: string } {
  if (!(e instanceof ApiFailure)) return { errors: {}, text: "That could not be done." };
  const errors = (e.body as { errors?: Errors & { toolJobs?: string } } | null)?.errors ?? {};
  return { errors, text: Object.keys(errors).length === 0 ? readableError(e, "That could not be done.") : undefined };
}

/**
 * Creating a Clot: an icon, a name and a repository; its tools; then Create. The same steps edit an existing Clot (the name fixed,
 * Save instead of Create). The step, name, repository, icon and tools live in the address, so a reload keeps them, and a reload
 * during a build shows where it is. The steps slide, the current one leaving to the left; progress arrives as the daemon builds it.
 */
export function NewClot() {
  const router = useRouter();
  const params = useSearchParams();
  const { subscribe, clots, connection, refresh } = useAppState();
  const reduce = useReducedMotion();
  const edit = params.get("edit") ?? undefined;
  const step = parseStep(params.get("step"));
  const existing = edit === undefined ? undefined : clots.find((c) => c.name === edit);

  const [name, setName] = useState(edit ?? params.get("name") ?? "");
  const [repo, setRepo] = useState(params.get("repo") ?? "");
  const [icon, setIcon] = useState<ClotIconValue>(iconFromParam(params.get("icon")) ?? DEFAULT_ICON);
  const [held, setHeld] = useState<HeldTool[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [invite, setInvite] = useState<Invite>();
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toolsProblem, setToolsProblem] = useState<string>();
  const [build, setBuild] = useState<Build>();
  const prefilled = useRef(false);
  const heldReady = useRef(false);

  // What an edit starts from: the Clot as saved. The address wins for what the user already changed before a reload.
  const original = useMemo(() => ({ icon: existing?.icon, repository: existing?.repository ?? null }), [existing]);
  useEffect(() => {
    if (edit === undefined || existing === undefined || prefilled.current) return;
    prefilled.current = true;
    if (iconFromParam(params.get("icon")) === undefined && existing.icon) setIcon(existing.icon);
    if (!params.has("repo") && existing.repository) setRepo(existing.repository);
  }, [edit, existing, params]);
  const repoChanged = edit !== undefined && original.repository !== null && repo.trim().toLowerCase() !== original.repository.toLowerCase();

  // The tools held for this Clot come back with a reload: the address has the jobs, the tab's storage the rest.
  useEffect(() => {
    if (heldReady.current) return;
    heldReady.current = true;
    const ids = (params.get("tools") ?? "").split(",").filter((id) => id !== "");
    if (ids.length === 0) return;
    const remembered = recalledHeld();
    void Promise.all(
      ids.map(async (jobId): Promise<HeldTool | undefined> => {
        const job = await api<{ toolkit: string; name?: string; held?: boolean; state: string }>(`/integrations/jobs/${enc(jobId)}`).catch(() => undefined);
        if (job?.held !== true) return undefined;
        const known = remembered.find((r) => r.jobId === jobId);
        return { jobId, toolkit: known?.toolkit ?? { slug: job.toolkit, name: job.name ?? job.toolkit, auth: "oauth" }, options: known?.options ?? { audience: "team", selfIsUser: true, shared: false, events: true, pollMinutes: 30 }, state: job.state === "failed" ? "failed" : "active" };
      }),
    ).then((list) => setHeld(list.filter((h): h is HeldTool => h !== undefined)));
  }, [params]);

  // The address follows the form without adding history entries; only a change of step is a new entry (so Back goes a step back).
  useEffect(() => {
    // New Clot is not a phone screen: the page is sending the phone to the Clots list, and must not write its own address over that.
    if (window.matchMedia("(max-width: 767px)").matches) return;
    const q = new URLSearchParams(window.location.search);
    const put = (key: string, value: string | undefined) => (value === undefined || value === "" ? q.delete(key) : q.set(key, value));
    put("name", edit === undefined ? name : undefined);
    put("repo", repo);
    put("icon", iconToParam(icon) === iconToParam(DEFAULT_ICON) ? undefined : iconToParam(icon));
    put("tools", held.map((h) => h.jobId).join(","));
    const next = q.toString();
    if (next !== window.location.search.replace(/^\?/, "")) window.history.replaceState(null, "", `${window.location.pathname}${next === "" ? "" : `?${next}`}`);
    rememberHeld(held);
  }, [name, repo, icon, held, edit]);

  const go = useCallback(
    (next: Step, how: "push" | "replace" = "push") => {
      const q = new URLSearchParams(window.location.search);
      q.set("step", next);
      router[how](`/new?${q.toString()}`);
    },
    [router],
  );

  // A step needs what the earlier ones gave: a visit to the tools without a name starts at the beginning.
  const needsStart = step !== "details" && (name === "" || (edit === undefined && repo === ""));
  useEffect(() => {
    if (needsStart) router.replace(edit === undefined ? "/new" : `/new?edit=${enc(edit)}`);
  }, [needsStart, router, edit]);

  // Which way the steps slide: forward to the right, back to the left.
  const [seen, setSeen] = useState(step);
  const [direction, setDirection] = useState(1);
  if (seen !== step) {
    setSeen(step);
    setDirection(STEPS.indexOf(step) > STEPS.indexOf(seen) ? 1 : -1);
  }

  // Progress arrives as events. After a reload nothing has arrived yet: the daemon may say where it is (`/build`), and if it cannot,
  // a finished create has put its first message in the chat, and a finished move has changed the Clot's repository.
  useEffect(() => subscribe((e) => e.type === "clot.build" && sameName(e.data.clot, name) && setBuild({ step: e.data.step, log: e.data.log })), [subscribe, name]);
  useEffect(() => {
    if (step !== "create" || build !== undefined || name === "") return;
    let live = true;
    const look = async () => {
      const state = await api<Build>(`/clots/${enc(name)}/build`).catch(() => undefined);
      if (!live) return;
      if (state) return setBuild(state);
      if (edit === undefined) {
        const page = await api<MessagePage>(`/clots/${enc(name)}/messages`).catch(() => undefined);
        if (live && page?.messages.some((m) => m.kind === "onboarding")) setBuild({ step: "done" });
      } else {
        const list = await api<{ name: string; repository: string | null }[]>("/clots").catch(() => undefined);
        if (live && list?.some((c) => c.name === edit && c.repository?.toLowerCase() === repo.trim().toLowerCase())) setBuild({ step: "done" });
      }
    };
    void look();
    const timer = setInterval(() => void look(), 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [step, build, name, edit, repo]);
  useEffect(() => {
    if (build?.step !== "done") return;
    void refresh().then(() => router.push(edit === undefined ? `/c/${enc(name)}` : "/settings/clots"));
  }, [build?.step, name, edit, refresh, router]);

  const next = async () => {
    setErrors({});
    setInvite(undefined);
    if (edit !== undefined) return go("tools");
    setChecking(true);
    try {
      const res = await api<{ ok: boolean; errors: Errors; invite?: Invite }>("/clots/validate", { method: "POST", body: { name, repo } });
      if (!res.ok) {
        setErrors(res.errors);
        setInvite(res.invite);
        return;
      }
      go("tools");
    } catch (e) {
      setErrors({ repo: e instanceof ApiFailure && e.unreachable ? readableError(e, "") : "That could not be checked." });
    } finally {
      setChecking(false);
    }
  };

  const create = async () => {
    setSaving(true);
    setToolsProblem(undefined);
    try {
      await api("/clots", { method: "POST", body: { name, repo, icon, ...(held.length === 0 ? {} : { toolJobs: held.map((h) => h.jobId) }) } });
      setBuild({ step: "cloning" });
      go("create");
    } catch (e) {
      const { errors: errs, text } = fieldErrors(e);
      if (errs.name || errs.repo) {
        setErrors(errs);
        go("details", "replace");
      } else setToolsProblem(errs.toolJobs ?? text ?? "That could not be created.");
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (edit === undefined) return;
    setSaving(true);
    setToolsProblem(undefined);
    try {
      const res = await api<{ ok: boolean; moving?: boolean }>(`/clots/${enc(edit)}`, { method: "PUT", body: { icon, ...(repoChanged ? { repo: repo.trim() } : {}) } });
      if (res.moving) {
        setBuild({ step: "cloning" });
        go("create");
      } else {
        await refresh();
        toast(`Saved ${edit}`);
        router.push("/settings/clots");
      }
    } catch (e) {
      const { errors: errs, text } = fieldErrors(e);
      if (errs.repo) {
        setErrors({ repo: errs.repo });
        go("details", "replace");
      } else setToolsProblem(text ?? "That could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const retry = async () => {
    setBuild({ step: "cloning" });
    await api(`/clots/${enc(name)}/retry`, { method: "POST", body: {} }).catch(() => setBuild({ step: "failed", log: "Retry could not be started." }));
  };

  /** Reset: back to an empty form (or, for an edit, to the Clot as saved). Tools held for a Clot not made yet are let go. */
  const reset = (o: { release: boolean } = { release: true }) => {
    if (o.release) for (const h of held) void api(`/integrations/jobs/${enc(h.jobId)}/abandon`, { method: "POST", body: {} }).catch(() => undefined);
    setHeld([]);
    setErrors({});
    setInvite(undefined);
    setBuild(undefined);
    setToolsProblem(undefined);
    if (edit !== undefined) {
      setIcon(original.icon ?? DEFAULT_ICON);
      setRepo(original.repository ?? "");
      router.replace(`/new?edit=${enc(edit)}`);
      return;
    }
    setName("");
    setRepo("");
    setIcon(DEFAULT_ICON);
    router.replace("/new");
  };

  const failedTool = held.find((h) => h.state === "failed");
  const moving = edit !== undefined;
  const title = edit !== undefined ? (step === "create" ? (build?.step === "failed" ? `Saving ${name} failed` : `Saving ${name}`) : `Edit ${name}`) : step === "details" ? "Create a new Clot" : build?.step === "failed" ? `Creating ${name} failed` : `Creating ${name}`;

  const variants: Variants = {
    enter: (d: number) => ({ x: reduce ? 0 : d * 40, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (d: number) => ({ x: reduce ? 0 : d * -40, opacity: 0 }),
  };

  return (
    <div className="h-full overflow-y-auto" tabIndex={0} role="region" aria-label={edit === undefined ? "New Clot" : `Edit ${edit}`}>
      <div className="content-width flex min-h-full flex-col gap-7 p-10">
        <header className="flex items-center justify-between">
          <h1 className="flex items-center gap-3 text-title leading-normal">
            <AnimatePresence initial={false}>
              {step === "details" ? null : (
                <motion.span key="icon" initial={reduce ? false : { opacity: 0, scale: 0.6, width: 0 }} animate={{ opacity: 1, scale: 1, width: 40 }} exit={{ opacity: 0, scale: 0.6, width: 0 }} transition={{ duration: reduce ? 0 : 0.2 }} className="flex shrink-0 justify-center overflow-hidden" style={{ height: 40 }}>
                  <IconTile tone="soft">
                    <ClotIcon icon={icon} size={24} tile={40} />
                  </IconTile>
                </motion.span>
              )}
            </AnimatePresence>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={title} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }} transition={{ duration: reduce ? 0 : 0.15 }}>
                {title}
              </motion.span>
            </AnimatePresence>
          </h1>
          {step !== "create" ? (
            <Button variant="ghost" size="sm" onClick={() => reset()}>
              <ArrowCounterClockwiseIcon /> Reset
            </Button>
          ) : null}
        </header>
        <AnimatePresence mode="wait" initial={false} custom={direction}>
          <motion.div key={step} custom={direction} variants={variants} initial="enter" animate="center" exit="exit" transition={{ duration: reduce ? 0 : 0.2 }} className="flex flex-1 flex-col">
            {step === "details" ? (
              <form
                className="flex flex-1 flex-col gap-7"
                onSubmit={(e) => {
                  e.preventDefault();
                  void next();
                }}
              >
                <div className="flex flex-col gap-2">
                  <FieldLabel>Icon</FieldLabel>
                  <IconPicker value={icon} onChange={setIcon} />
                </div>
                <div className="flex max-w-130 flex-col gap-2">
                  <FieldLabel htmlFor="clot-name">Name</FieldLabel>
                  <Input
                    id="clot-name"
                    value={name}
                    disabled={edit !== undefined}
                    onChange={(e) => {
                      setName(e.target.value);
                      setErrors((x) => ({ ...x, name: undefined }));
                    }}
                    autoComplete="off"
                    aria-invalid={errors.name !== undefined}
                    aria-describedby={errors.name ? "clot-name-error" : undefined}
                  />
                  {errors.name ? (
                    <p id="clot-name-error" role="alert" className="text-caption text-primary-ink">
                      {errors.name}
                    </p>
                  ) : null}
                </div>
                {edit !== undefined && original.repository === null ? null : (
                  <div className="flex max-w-130 flex-col gap-2">
                    <FieldLabel htmlFor="clot-repo">GitHub repository</FieldLabel>
                    <InputGroup aria-invalid={errors.repo !== undefined}>
                      <InputGroupAddon>
                        <GithubLogoIcon />
                      </InputGroupAddon>
                      <InputGroupInput
                        id="clot-repo"
                        value={repo}
                        placeholder="owner/name"
                        onChange={(e) => {
                          setRepo(e.target.value.trim());
                          setErrors((x) => ({ ...x, repo: undefined }));
                          setInvite(undefined);
                        }}
                        autoComplete="off"
                        aria-invalid={errors.repo !== undefined}
                        aria-describedby={errors.repo ? "clot-repo-error" : undefined}
                      />
                    </InputGroup>
                    {errors.repo ? (
                      <p id="clot-repo-error" role="alert" className="text-caption text-primary-ink">
                        {errors.repo}
                      </p>
                    ) : null}
                    {invite ? <p className="text-caption text-muted-foreground">Invite {invite.login ?? "the machine account"} as a collaborator on the repository, then press Check again.</p> : null}
                    {repoChanged ? <p className="text-caption text-muted-foreground">Saving clones this repository into a fresh workspace and moves {name} onto it. The old workspace is kept.</p> : null}
                  </div>
                )}
                <div className="mt-auto flex justify-end">
                  <Button type="submit" disabled={checking || connection === "down" || name === "" || (repo === "" && !(edit !== undefined && original.repository === null))}>
                    {checking ? <Spinner /> : null}
                    {invite ? "Check again" : "Next"}
                    <ArrowRightIcon />
                  </Button>
                </div>
              </form>
            ) : step === "tools" ? (
              <div className="flex flex-1 flex-col gap-6">
                <ToolsStep name={name} exists={edit !== undefined} held={held} onHeld={setHeld} problem={failedTool ? `${failedTool.toolkit.name} did not connect. Open its menu to change its settings, or remove it.` : toolsProblem} />
                <div className="mt-auto flex justify-between">
                  <Button variant="outline" onClick={() => go("details")}>
                    <ArrowLeftIcon /> Back
                  </Button>
                  <Button disabled={saving || connection === "down" || failedTool !== undefined} onClick={() => void (edit === undefined ? create() : save())}>
                    {saving ? <Spinner /> : null}
                    {edit === undefined ? `Create ${name}` : "Save"}
                  </Button>
                </div>
              </div>
            ) : (
              <BuildProgress name={name} build={build} moving={moving} onRetry={() => void retry()} onStartOver={() => (moving ? router.push("/settings/clots") : reset({ release: false }))} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
