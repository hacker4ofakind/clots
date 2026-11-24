import type { Metadata } from "next";
import { ClotsList } from "@/components/clots/clots-list";

export const metadata: Metadata = { title: "Clots" };

export default function ClotsPage() {
  return <ClotsList />;
}
