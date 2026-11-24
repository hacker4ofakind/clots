import { notFound } from "next/navigation";
import { ToolTilesHarness } from "./harness";

/** A page for the end-to-end tests only: it exists when the test server sets CLOTS_E2E_HARNESS, and is a 404 everywhere else. */
export default function Page() {
  if (process.env.CLOTS_E2E_HARNESS !== "1") notFound();
  return <ToolTilesHarness />;
}
