// Browser tests: the Worker runs under `wrangler dev` (workerd, with local KV and Durable Objects) on a fresh
// state folder each run, seeded by e2e/global-setup.js. Run with `npm run e2e`.

import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { ADMIN_PASSWORD, API_TOKEN, BASE_URL, LINK_SECRET, PORT } from "./e2e/fixtures.js";

const state = join(tmpdir(), `hermitshell-e2e-${Date.now()}`);
const vars = { JOB_FEEDBACK_SECRET: LINK_SECRET, JOB_FEEDBACK_API_TOKEN: API_TOKEN, ADMIN_PASSWORD };

export default defineConfig({
  testDir: "e2e",
  // One Worker and one KV shared by every test, so they run in file order, one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],
  globalSetup: "./e2e/global-setup.js",
  use: { baseURL: BASE_URL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to "${state}" `
      + Object.entries(vars).map(([k, v]) => `--var ${k}:${v}`).join(" "),
    url: `${BASE_URL}/privacy`,
    reuseExistingServer: false,
    timeout: 120000,
    env: { WRANGLER_SEND_METRICS: "false" },
  },
});
