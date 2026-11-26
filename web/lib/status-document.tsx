import type { ComponentType, ReactNode } from "react";
import type { IconProps } from "@phosphor-icons/react";
import { GearSixIcon, LockIcon } from "@phosphor-icons/react/ssr";
import { StatusPage } from "@/components/clots/status-page";
import { renderStatic } from "@/lib/static-html";

/**
 * The colours the pages below use, copied from the tokens in `app/globals.css` (a test checks every value is still there).
 * These pages are answered by the proxy before the app's stylesheet can load, so they carry their own small one.
 */
export const statusTokens = {
  background: ["oklch(0.972 0.005 18.67)", "oklch(0.17 0.006 18.67)"],
  card: ["oklch(1 0 0)", "oklch(0.215 0.007 18.67)"],
  foreground: ["oklch(0.21 0.008 18.67)", "oklch(0.95 0.004 18.67)"],
  "foreground-soft": ["oklch(0.38 0.01 18.67)", "oklch(0.82 0.006 18.67)"],
  muted: ["oklch(0.962 0.006 18.67)", "oklch(0.26 0.008 18.67)"],
  "muted-foreground": ["oklch(0.5 0.01 18.67)", "oklch(0.68 0.008 18.67)"],
  border: ["oklch(0.91 0.008 18.67)", "oklch(0.29 0.008 18.67)"],
  primary: ["oklch(0.58 0.21 18.67)", "oklch(0.58 0.21 18.67)"],
  "primary-hover": ["oklch(0.53 0.2 18.67)", "oklch(0.63 0.21 18.67)"],
  "primary-foreground": ["oklch(1 0 0)", "oklch(1 0 0)"],
  brand: ["oklch(0.6352 0.2244 18.67)", "oklch(0.6352 0.2244 18.67)"],
} as const;

const vars = (i: 0 | 1) =>
  Object.entries(statusTokens)
    .map(([name, pair]) => `--${name}:${pair[i]}`)
    .join(";");

/** Styles `StatusPage`'s own slots (its Tailwind classes are not available here) to match the app's page. */
const css = `
:root{${vars(0)};color-scheme:light}
@media (prefers-color-scheme:dark){:root{${vars(1)};color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--background);color:var(--foreground);font:14px/21px "Rethink Sans",ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
[data-slot=status-page]{display:flex;min-height:100dvh;padding:10px}
[data-slot=status-panel]{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:0 40px 80px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:16px}
[data-slot=status-tile]{display:flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:18px;background:var(--muted);color:var(--foreground-soft)}
[data-slot=status-title]{margin:0;font-size:26px;line-height:32px;font-weight:700;letter-spacing:-.01em;text-wrap:balance}
[data-slot=status-text]{margin:0;max-width:24rem;font-size:15px;line-height:24px;color:var(--muted-foreground);text-wrap:balance}
[data-slot=status-text] code{font:13.5px/20px ui-monospace,monospace;color:var(--foreground)}
[data-slot=status-actions]{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:6px}
.status-action{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border-radius:8px;background:var(--primary);color:var(--primary-foreground);font-size:14px;line-height:1;font-weight:550;text-decoration:none}
.status-action:hover{background:var(--primary-hover)}
.status-action:focus-visible{outline:3px solid color-mix(in oklch,var(--brand) 50%,transparent);outline-offset:2px}
@media (max-width:767px){
[data-slot=status-page]{padding:0}
[data-slot=status-panel]{padding:0 28px 80px;border:0;border-radius:0}
[data-slot=status-title]{font-size:30px;line-height:36px;font-weight:750;letter-spacing:-.015em}
.status-action{height:44px;padding:0 16px}
}`;

function htmlDocument(title: string, body: ReactNode): string {
  const meta = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${css}</style>`;
  return `<!doctype html><html lang="en"><head>${meta}</head><body>${renderStatic(body)}</body></html>`;
}

function statusDocument(icon: ComponentType<IconProps>, title: string, text: ReactNode, action: { label: string; href: string }): string {
  return htmlDocument(
    title,
    <StatusPage
      icon={icon}
      title={title}
      actions={
        <a className="status-action" href={action.href}>
          {action.label}
        </a>
      }
    >
      {text}
    </StatusPage>,
  );
}

/** The page for a visitor who is not the owner (403). Says nothing about who the owner is. */
export const accessDeniedHtml = (): string => statusDocument(LockIcon, "Clots is private", "Only its owner can open it, from their own Tailscale network. Sign in to Tailscale with that account, then reload.", { label: "Reload", href: "/" });

/** The page for a Clots install whose `ui.owner` is not set yet (503). */
export const notSetUpHtml = (): string => statusDocument(GearSixIcon, "Clots is not set up", <>Set <code>ui.owner</code> in clots.config.json to your Tailscale login, then reload.</>, { label: "Reload", href: "/" });
