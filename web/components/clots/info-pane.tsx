import { GithubLogoIcon } from "@phosphor-icons/react";
import type { ClotInfo } from "@clots/ui-api-schemas";
import { ConnectionIcon } from "./connection-icon";

/** What the info pane shows of a Clot: its repository and what it is connected to, each with the service's own logo where there is one. */
export function InfoPane({ info }: { info: ClotInfo }) {
  return (
    <div className="flex flex-col gap-5.5">
      <h2 className="text-section leading-normal">Info</h2>
      <div className="flex items-center justify-between gap-3 text-body">
        <span className="text-label text-foreground-soft">Repository</span>
        {info.repository ? (
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-code">
            <GithubLogoIcon size={16} aria-hidden />
            <span className="truncate">{info.repository}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </div>
      <section aria-labelledby="info-connections" className="flex flex-col gap-2.5">
        <h3 id="info-connections" className="text-label text-foreground-soft">
          Connections
        </h3>
        {info.connections.length === 0 ? (
          <p className="text-body text-muted-foreground">Nothing is connected yet.</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {info.connections.map((c) => (
              <li key={`${c.kind}:${c.account}`} className="flex items-center gap-2.5 text-body">
                <ConnectionIcon kind={c.kind} toolkit={c.toolkit} address={c.kind === "email" ? c.label : undefined} size={16} />
                <span className="min-w-0 truncate">{c.kind === "composio" ? toolkitName(c) : c.label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A tool's name for the list: the toolkit, capitalised ("Notion"), with the account when it is not obvious. */
function toolkitName(c: ClotInfo["connections"][number]): string {
  const toolkit = c.toolkit ?? c.label;
  return toolkit.replace(/(^|_)(\w)/g, (_m, sep: string, ch: string) => (sep === "_" ? " " : "") + ch.toUpperCase());
}
