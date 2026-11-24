import { defineConfig, devices } from "@playwright/test";

// The ports can be moved (E2E_WEB_PORT, E2E_DAEMON_PORT) when another session has the usual ones; a moved web port gets its own build folder.
const WEB = Number(process.env.E2E_WEB_PORT ?? 3100);
const DAEMON = Number(process.env.E2E_DAEMON_PORT ?? 8791);
const env = { CLOTS_DAEMON_URL: `http://127.0.0.1:${DAEMON}`, CLOTS_UI_SECRET: "e2e-secret", CLOTS_UI_DEV_OWNER: "owner@example.com", CLOTS_UI_DEV_HOST: "localhost", FAKE_DAEMON_PORT: String(DAEMON), NEXT_DIST_DIR: WEB === 3100 ? ".next-e2e" : `.next-e2e-${WEB}`, CLOTS_E2E_HARNESS: "1" };

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${WEB}`, extraHTTPHeaders: { "tailscale-user-login": "owner@example.com" }, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", testIgnore: /phone\.spec/, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { "tailscale-user-login": "owner@example.com" } } },
    { name: "phone", testMatch: /phone\.spec/, use: { ...devices["Pixel 7"], extraHTTPHeaders: { "tailscale-user-login": "owner@example.com" } } },
  ],
  webServer: [
    { command: "node --import tsx e2e/fake-daemon.mts", cwd: ".", env, port: DAEMON + 1, reuseExistingServer: !process.env.CI, timeout: 60_000 },
    { command: `npx next dev -H 127.0.0.1 -p ${WEB}`, cwd: ".", env, port: WEB, reuseExistingServer: !process.env.CI, timeout: 120_000},
  ],
});
