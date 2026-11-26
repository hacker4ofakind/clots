"use client";

import { Fragment, useId, useState } from "react";
import { ArrowLeftIcon, EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import type { Toolkit } from "@/lib/integrations";
import { ToolLogo } from "../tool-logo";
import { StepFrame } from "./step-frame";

const URL = /(https:\/\/[^\s<>"')]+[^\s<>"')\].,;:!?])/g;

/** The configurer's instructions as steps: one per line, numbering stripped (the list numbers them), https links made clickable. */
export function instructionSteps(text: string | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter((line) => line !== "");
}

function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(URL).map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="break-all text-primary-ink underline underline-offset-2">
            {part.replace(/^https:\/\//, "")}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * Step four for a toolkit that takes an API key: the key field (its value only ever goes to the daemon's `.env`) and the
 * configurer's instructions for getting one. Done is off while the field is empty.
 */
export function KeyStep({ toolkit, instructions, saving, error, onBack, onDone }: { toolkit: Toolkit; instructions?: string; saving: boolean; error?: string; onBack: () => void; onDone: (value: string) => void }) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const id = useId();
  const steps = instructionSteps(instructions);
  const ready = value.trim() !== "" && !saving;
  return (
    <StepFrame
      title={`Configure ${toolkit.name}`}
      logo={<ToolLogo toolkit={toolkit.slug} name={toolkit.name} logo={toolkit.logo} size="sm" />}
      footer={
        <>
          <Button variant="outline" onClick={onBack}>
            <ArrowLeftIcon /> Back
          </Button>
          <Button data-primary disabled={!ready} onClick={() => onDone(value.trim())}>
            {saving ? <Spinner /> : null}
            Done
          </Button>
        </>
      }
    >
      <div className="flex flex-1 flex-col gap-5.5 py-3.5">
        <p className="text-chat">You’re almost done! Enter an API key.</p>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id} className="text-label text-foreground-soft">
            API key
          </Label>
          <InputGroup>
            <InputGroupInput id={id} type={show ? "text" : "password"} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ready && onDone(value.trim())} autoComplete="off" spellCheck={false} aria-invalid={error ? true : undefined} className="font-mono text-code md:text-code" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label={show ? "Hide the key" : "Show the key"} aria-pressed={show} onClick={() => setShow(!show)}>
                {show ? <EyeSlashIcon /> : <EyeIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          {error ? (
            <p role="alert" className="text-caption text-primary-ink">
              {error}
            </p>
          ) : null}
        </div>
        {steps.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            <h3 className="text-label text-foreground-soft">How to get one</h3>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-body">
              {steps.map((step, i) => (
                <li key={i}>
                  <Linked text={step} />
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </StepFrame>
  );
}
