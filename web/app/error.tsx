"use client";

import { useEffect } from "react";
import { WarningIcon } from "@phosphor-icons/react";
import { StatusPage, statusButtonClass } from "@/components/clots/status-page";
import { Button } from "@/components/ui/button";

/** What the user sees when a page fails while it renders. The cause goes to the console, never onto the screen; the digest is the short code that finds it in the server's log. */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  return (
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
            {/* A full load, so a broken page's state cannot follow the user. */}
            <a href="/waiting">Go to Waiting for you</a>
          </Button>
        </>
      }
    >
      Clots hit a problem showing this page. Try again, or go back to Waiting for you.
    </StatusPage>
  );
}
