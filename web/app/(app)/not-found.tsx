import type { Metadata } from "next";
import { NotFoundPage } from "@/components/clots/not-found-page";

export const metadata: Metadata = { title: "Page not found" };

/** What `notFound()` renders inside the shell (a Clot that does not exist), so the rail stays in reach. */
export default function AppNotFound() {
  return <NotFoundPage framed={false} />;
}
