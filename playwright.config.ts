import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // First hits to each API route compile on demand in dev; a cold server plus
  // a full tenant-attack sequence comfortably exceeds the 30s default.
  timeout: 120_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ["html", { open: "never" }],
    ["list"],
  ],
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    // Local machines without Playwright's downloaded browsers can set
    // PW_CHANNEL=chrome to drive an installed Chrome instead (CI uses the
    // bundled chromium it installs in its own step).
    channel: process.env.PW_CHANNEL || undefined,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.CI
    ? undefined
    : {
        command: "npx next dev -p 3000",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 60000,
      },
});
