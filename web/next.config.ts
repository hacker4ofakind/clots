import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // A second dev server in this folder needs a build folder of its own (`NEXT_DIST_DIR=.next-2`).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // `next dev` behind `tailscale serve` is reached on the tailnet host, whose dev resources (the HMR socket)
  // Next blocks by default, so the page never hydrates. Comma-separated hosts; development only.
  allowedDevOrigins: (process.env.CLOTS_UI_DEV_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
  reactStrictMode: true,
  devIndicators: false,
  turbopack: {
    // The dependencies are hoisted to the workspace root.
    root: path.join(__dirname, ".."),
    // Tailwind v4's Turbopack loader (what create-next-app sets up).
    rules: { "*.css": { loaders: [{ loader: "@tailwindcss/turbopack", options: { base: __dirname } }], as: "*.css" } },
  },
  outputFileTracingRoot: path.join(__dirname, ".."),
  transpilePackages: ["@clots/ui-api-schemas"],
  images: {
    // Service logos come from Composio.
    remotePatterns: [{ protocol: "https", hostname: "logos.composio.dev" }],
  },
};

export default nextConfig;
