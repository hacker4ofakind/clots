import type { Metadata, Viewport } from "next";
import { Rethink_Sans, Red_Hat_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { uiPrefs } from "@/lib/ui-prefs";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const sans = Rethink_Sans({ subsets: ["latin"], variable: "--font-sans-face", display: "swap" });
const mono = Red_Hat_Mono({ subsets: ["latin"], variable: "--font-mono-face", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Clots", template: "%s · Clots" },
  description: "Talk to your Clots and answer what they need from you.",
  applicationName: "Clots",
  appleWebApp: { capable: true, title: "Clots", statusBarStyle: "default" },
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icons/mark.svg", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  // The browser's chrome colour has to be a plain colour, not a CSS variable: these are the page background token (`--background`) in each theme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf6f6" },
    { media: "(prefers-color-scheme: dark)", color: "#141011" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // The daemon's theme is the one source of truth. The theme script below reads the browser's copy first, so that copy is made to say the
  // same before it runs: whatever an old visit left there, the first paint (and a page outside the app's shell) shows the chosen theme.
  const theme = (await uiPrefs())?.theme;
  return (
    <html lang="en" suppressHydrationWarning className={cn("h-full antialiased", sans.variable, mono.variable)}>
      <body className="min-h-full">
        {theme === undefined ? null : <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: `try{localStorage.setItem("theme",${JSON.stringify(theme)})}catch(e){}` }} />}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange nonce={nonce}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
