import type { Metadata } from "next";
import { GeneralSettings } from "@/components/clots/settings/general";

export const metadata: Metadata = { title: "General settings" };

export default function Page() {
  return <GeneralSettings />;
}
