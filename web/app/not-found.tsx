import type { Metadata } from "next";
import { NotFoundPage } from "@/components/clots/not-found-page";

export const metadata: Metadata = { title: "Page not found" };

/** Unknown addresses. */
export default function NotFound() {
  return <NotFoundPage framed />;
}
