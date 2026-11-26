"use client";

import { useEffect } from "react";
import { Red_Hat_Mono, Rethink_Sans } from "next/font/google";
import { WarningIcon } from "@phosphor-icons/react";
import "./globals.css";
import { StatusPage, statusButtonClass } from "@/components/clots/status-page";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const sans = Rethink_Sans({ subsets: ["latin"], variable: "--font-sans-face", display: "swap" });
const mono = Red_Hat_Mono({ subsets: ["latin"], variable: "--font-mono-face", display: "swap" });

/**
 * Shown when the root layout itself fails, so none of the app's providers exist: it brings its own document, the
 * stylesheet and the fonts, and picks the theme the user chose (kept by the theme provider) or else the device's.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
    let dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    try {
      const chosen = localStorage.getItem("theme");
      if (chosen === "dark") dark = true;
      else if (chosen === "light") dark = false;
    } catch {
      // Storage is blocked: the device's theme stands.
    }
    document.documentElement.classList.toggle("dark", dark);
  }, [error]);
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  return (
    <html lang="en" suppressHydrationWarning className={cn("h-full antialiased", sans.variable, mono.variable)}>
      <head>
        <title>Something went wrong</title>
      </head>
      <body className="min-h-full">
        <StatusPage
          icon={WarningIcon}
          title="Something went wrong"
          reference={digest}
          actions={
            <>
              <Button className={statusButtonClass} onClick={() => retry()}>
                Try again
              </Button>
              <Button asChild variant="outline" className={statusButtonClass}>
                <a href="/waiting">Go to Waiting for you</a>
              </Button>
            </>
          }
        >
          Clots hit a problem showing this page. Try again, or go back to Waiting for you.
        </StatusPage>
      </body>
    </html>
  );
}
