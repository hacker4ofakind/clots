import type { Metadata } from "next";
import { ManageClots } from "@/components/clots/settings/manage-clots";

export const metadata: Metadata = { title: "Manage Clots" };

export default function Page() {
  return <ManageClots />;
}
