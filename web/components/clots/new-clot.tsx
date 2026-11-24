"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowCounterClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, CheckCircleIcon, GithubLogoIcon, WarningIcon } from "@phosphor-icons/react";
import type { ClotIcon as ClotIconValue } from "@clots/ui-api-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiFailure } from "@/lib/api-client";
import { useAppState } from "./app-state";
import { ClotIcon } from "./clot-icon";
import { IconPicker } from "./icon-picker";
import { IconTile } from "./icon-tile";

type Step = "details" | "tools" | "create";
type Build = { step: "cloning" | "building" | "starting" | "done" | "failed"; log?: string };
const BUILD_LABEL: Record<string, string> = { cloning: "Cloning the repository", building: "Building the container", starting: "Starting", done: "Ready" };

/**
 * Creating a Clot: an icon, a name and a repository; its tools; then Create. The step, name and repository live in the address, so
 * a reload keeps them. The steps slide, the current one leaving to the left. Progress arrives as the daemon builds it.
 */
export function NewClot() {
  const router = useRouter();
  const params = useSearchParams();
  const { subscribe, clots, connection, refresh } = useAppState();
  const reduce = useReducedMotion();
  const step = (params.get("step") as Step | null) ?? "details";
  const edit = params.get("edit") ?? undefined;
  const [name, setName] = useState(params.get("name") ?? edit ?? "");
  const [repo, setRepo] = useState(params.get("repo") ?? "");
  const [icon, setIcon] = useState<ClotIconValue>({ phosphor: "Sliders", color: "ink" });
  const [errors, setErrors] = useState<{ name?: string; repo?: string }>({});
  const [invite, setInvite] = useState<{ login?: string }>();
  const [checking, setChecking] = useState(false);
  const [build, setBuild] = useState<Build>();
  const [direction, setDirection] = useState(1);

  const go = useCallback(
    (next: Step, extra: Record<string, string> = {}) => {
      const q = new URLSearchParams({ step: next, name, repo, ...(edit ? { edit } : {}), ...extra });
      setDirection(next === "details" ? -1 : 1);
      router.replace(`/new?${q.toString()}`);
    },
    [router, name, repo, edit],
  );

  // A reload during a build shows where it is: the daemon says whether the Clot is still being made.
  useEffect(() => subscribe((e) => e.type === "clot.build" && e.data.clot === name && setBuild({ step: e.data.step, log: e.data.log })), [subscribe, name]);
  useEffect(() => {
    if (build?.step === "done") {
      void refresh().then(() => router.push(`/c/${encodeURIComponent(name)}`));
    }
  }, [build?.step, name, refresh, router]);
  useEffect(() => {
    if (edit) {
      const existing = clots.find((c) => c.name === edit);
      if (existing?.icon) setIcon(existing.icon);
    }
  }, [edit, clots]);

  const next = async () => {
    setChecking(true);
    setErrors({});
    setInvite(undefined);
    try {
      if (edit) {
        await api(`/clots/${encodeURIComponent(edit)}`, { method: "PUT", body: { icon } });
        router.push("/settings/clots");
        return;
      }
      const res = await api<{ ok: boolean; errors: { name?: string; repo?: string }; invite?: { login?: string } }>("/clots/validate", { method: "POST", body: { name, repo } });
      if (!res.ok) {
        setErrors(res.errors);
        setInvite(res.invite);
        return;
      }
      go("tools");
    } catch (e) {
      setErrors({ repo: e instanceof ApiFailure && e.unreachable ? "The daemon cannot be reached." : "That could not be checked." });
    } finally {
      setChecking(false);
    }
  };

  const create = async () => {
    setBuild({ step: "cloning" });
    go("create");
    try {
      await api("/clots", { method: "POST", body: { name, repo, icon } });
    } catch (e) {
      const errs = e instanceof ApiFailure ? (e.body as { errors?: Record<string, string> } | null)?.errors : undefined;
      setBuild({ step: "failed", log: errs ? Object.values(errs).join("\n") : "The daemon cannot be reached." });
    }
  };
  const retry = async () => {
    setBuild({ step: "cloning" });
    await api(`/clots/${encodeURIComponent(name)}/retry`, { method: "POST", body: {} }).catch(() => setBuild({ step: "failed", log: "Retry could not be started." }));
  };
  const reset = () => {
    setName("");
    setRepo("");
    setIcon({ phosphor: "Sliders", color: "ink" });
    setErrors({});
    setBuild(undefined);
    router.replace("/new");
  };

  const slide = reduce ? {} : { initial: { x: direction * 40, opacity: 0 }, animate: { x: 0, opacity: 1 }, exit: { x: direction * -40, opacity: 0 }, transition: { duration: 0.2 } };

  return (
    <div className="h-full overflow-y-auto" tabIndex={0} role="region" aria-label="New Clot">
      <div className="content-width flex min-h-full flex-col gap-7 p-10">
        <header className="flex items-center justify-between">
          <h1 className="flex items-center gap-3 text-title">
            {step === "details" || edit ? null : (
              <IconTile tone="soft">
                <ClotIcon icon={icon} size={24} tile={40} />
              </IconTile>
            )}
            {edit ? `Edit ${edit}` : step === "details" ? "Create a new Clot" : build?.step === "failed" ? `Creating ${name} failed` : `Creating ${name}`}
          </h1>
          {step !== "create" && !edit ? (
            <Button variant="ghost" size="sm" onClick={reset}>
              <ArrowCounterClockwiseIcon /> Reset
            </Button>
          ) : null}
        </header>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={step} {...slide} className="flex flex-1 flex-col">
            {step === "details" ? (
              <form
                className="flex flex-1 flex-col gap-7"
                onSubmit={(e) => {
                  e.preventDefault();
                  void next();
                }}
              >
                <div className="flex flex-col gap-2">
                  <Label className="text-label text-foreground-soft">Icon</Label>
                  <IconPicker value={icon} onChange={setIcon} />
                </div>
                <div className="flex max-w-130 flex-col gap-2">
                  <Label htmlFor="clot-name" className="text-label text-foreground-soft">
                    Name
                  </Label>
                  <Input id="clot-name" value={name} disabled={edit !== undefined} onChange={(e) => setName(e.target.value)} autoComplete="off" aria-invalid={errors.name !== undefined} />
                  {errors.name ? (
                    <p role="alert" className="text-caption text-primary-ink">
                      {errors.name}
                    </p>
                  ) : null}
                </div>
                {edit ? null : (
                  <div className="flex max-w-130 flex-col gap-2">
                    <Label htmlFor="clot-repo" className="text-label text-foreground-soft">
                      GitHub repository
                    </Label>
                    <InputGroup aria-invalid={errors.repo !== undefined}>
                      <InputGroupAddon>
                        <GithubLogoIcon />
                      </InputGroupAddon>
                      <InputGroupInput id="clot-repo" value={repo} placeholder="owner/name" onChange={(e) => setRepo(e.target.value.trim())} className="font-mono text-code md:text-code" autoComplete="off" aria-invalid={errors.repo !== undefined} />
                    </InputGroup>
                    {errors.repo ? (
                      <p role="alert" className="text-caption text-primary-ink">
                        {errors.repo}
                      </p>
                    ) : null}
                    {invite ? <p className="text-caption text-muted-foreground">Invite {invite.login ?? "the machine account"} as a collaborator on the repository, then press Check again.</p> : null}
                  </div>
                )}
                <div className="mt-auto flex justify-end">
                  <Button type="submit" disabled={checking || connection === "down" || name === "" || (!edit && repo === "")}>
                    {checking ? <Spinner /> : null}
                    {edit ? "Save" : invite ? "Check again" : "Next"}
                    {edit ? null : <ArrowRightIcon />}
                  </Button>
                </div>
              </form>
            ) : step === "tools" ? (
              <div className="flex flex-1 flex-col gap-6">
                <section>
                  <h2 className="text-section">Tools</h2>
                </section>
                <div className="mt-auto flex justify-between">
                  <Button variant="outline" onClick={() => go("details")}>
                    <ArrowLeftIcon /> Back
                  </Button>
                  <Button onClick={() => void create()}>Create {name}</Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4" aria-live="polite">
                {build?.step === "failed" ? (
                  <>
                    <p className="flex items-center gap-2 text-body text-primary-ink">
                      <WarningIcon aria-hidden /> {name} could not be created.
                    </p>
                    <pre className="max-h-72 overflow-auto rounded-control bg-muted p-3 font-mono text-code whitespace-pre-wrap">{build.log}</pre>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => go("details")}>
                        Back
                      </Button>
                      <Button onClick={() => void retry()}>Retry</Button>
                    </div>
                  </>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {(["cloning", "building", "starting"] as const).map((s) => {
                      const order = ["cloning", "building", "starting", "done"];
                      const at = order.indexOf(build?.step ?? "cloning");
                      const done = order.indexOf(s) < at;
                      return (
                        <li key={s} className="flex items-center gap-2 text-body" data-build-step={s} data-state={done ? "done" : order.indexOf(s) === at ? "now" : "next"}>
                          {done ? <CheckCircleIcon className="text-highlight-ink" weight="fill" aria-hidden /> : order.indexOf(s) === at ? <Spinner /> : <span className="size-4" aria-hidden />}
                          <span className={done ? "text-muted-foreground" : ""}>{BUILD_LABEL[s]}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
