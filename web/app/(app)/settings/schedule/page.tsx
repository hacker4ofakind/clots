import type { Metadata } from "next";
import { ScheduleSettings } from "@/components/clots/settings/schedule";

export const metadata: Metadata = { title: "Schedule settings" };

export default function Page() {
  return <ScheduleSettings />;
}
