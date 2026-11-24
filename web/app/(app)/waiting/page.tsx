import type { Metadata } from "next";
import { WaitingView } from "@/components/clots/waiting-view";

export const metadata: Metadata = { title: "Waiting for you" };

export default function WaitingPage() {
  return <WaitingView />;
}
