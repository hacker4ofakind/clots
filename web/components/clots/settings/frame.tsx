"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

const PAGES = [
  { href: "/settings/general", label: "General" },
  { href: "/settings/schedule", label: "Schedule" },
  { href: "/settings/clots", label: "Manage Clots" },
  { href: "/settings/integrations", label: "Integrations" },
];

/**
 * Settings, New Clot and integrations are not reachable from a phone: a phone that gets here is sent back to the Clots list.
 */
export function PhoneRedirect({ children }: { children: ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    const phone = window.matchMedia("(max-width: 767px)");
    const check = () => phone.matches && router.replace("/clots");
    check();
    phone.addEventListener("change", check);
    return () => phone.removeEventListener("change", check);
  }, [router]);

  return <div className="hidden h-full md:block">{children}</div>;
}

/** The settings pages' frame: their own navigation, a divider, and the page. */
export function SettingsFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <PhoneRedirect>
      <div className="flex h-full">
        <nav aria-label="Settings" className="flex w-55 shrink-0 flex-col gap-0.5 border-r px-4 py-8">
          {PAGES.map((page) => (
            <Link
              key={page.href}
              href={page.href}
              aria-current={pathname === page.href ? "page" : undefined}
              className={cn("rounded-control px-3 py-2 text-ui text-foreground-soft hover:bg-muted", pathname === page.href && "bg-muted font-semibold text-foreground")}
            >
              {page.label}
            </Link>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-12 py-8">
          <div className={cn("flex w-full flex-col gap-5", pathname === "/settings/general" ? "max-w-170" : "max-w-180")}>{children}</div>
        </div>
      </div>
    </PhoneRedirect>
  );
}
