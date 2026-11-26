import Link from "next/link";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/ssr";
import { StatusPage, statusButtonClass } from "@/components/clots/status-page";
import { Button } from "@/components/ui/button";

/** The 404 page. Framed on its own for an unknown address; unframed inside the shell when a Clot is missing. */
export function NotFoundPage({ framed }: { framed: boolean }) {
  return (
    <StatusPage
      framed={framed}
      icon={MagnifyingGlassIcon}
      title="We can't find that page"
      actions={
        <Button asChild className={statusButtonClass}>
          <Link href="/waiting">Go to Waiting for you</Link>
        </Button>
      }
    >
      The link may be old, or that Clot may have been removed.
    </StatusPage>
  );
}
