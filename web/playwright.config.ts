import { defineConfig, devices } from "@playwright/test";

const WEB = 3100;
const DAEMON = 8791;
const env = { CLOTS_DAEMON_URL: `http://127.0.0.1:${DAEMON}`, CLOTS_UI_SECRET: "e2e-secret", CLOTS_UI_DEV_OWNER: "owner@example.com", CLOTS_UI_DEV_HOST: "localhost", FAKE_DAEMON_PORT: String(DAEMON), NEXT_DIST_DIR: ".next-e2e" };

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
