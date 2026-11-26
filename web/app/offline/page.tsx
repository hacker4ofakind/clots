import type { Metadata } from "next";
import { OfflineRetry } from "./retry";

export const metadata: Metadata = { title: "Offline" };

/** Shown by the service worker when a page cannot be fetched. Static: no data, so nothing about the Clots is ever cached. */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-title-mobile text-balance md:text-title">Connect Tailscale to reach Clots.</h1>
      <OfflineRetry />
    </main>
  );
}
