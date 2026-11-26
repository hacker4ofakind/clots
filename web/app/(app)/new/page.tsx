import type { Metadata } from "next";
import { Suspense } from "react";
import { NewClot } from "@/components/clots/new-clot";
import { PhoneRedirect } from "@/components/clots/settings/frame";

export const metadata: Metadata = { title: "New Clot" };

export default function NewPage() {
  return (
    <PhoneRedirect>
      <Suspense>
        <NewClot />
      </Suspense>
    </PhoneRedirect>
  );
}
