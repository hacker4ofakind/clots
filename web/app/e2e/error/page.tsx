import { cookies } from "next/headers";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Test only: fails on purpose, so the e2e suite can see the error page and its "Try again". It exists only
 * where CLOTS_E2E_HARNESS=1 is set (the e2e runs); everywhere else it is an ordinary 404. The `e2e-ok` cookie
 * lets a test make the next attempt succeed.
 */
export default async function FailOnPurpose() {
  if (process.env.CLOTS_E2E_HARNESS !== "1") notFound();
  if ((await cookies()).get("e2e-ok")?.value !== "1") throw new Error("Internal detail that must never reach the screen");
  return <p>Recovered</p>;
}
