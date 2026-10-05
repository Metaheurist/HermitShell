// The exploratory walkthrough (docs/exploratory-testing.md): headed, one journey at a time, against the local stack
// started by `node explore/run.mjs up`. Output goes to the run folder outside the repo. Not part of CI.

import { join } from "node:path";

import { defineConfig } from "@playwright/test";

const out = process.env.EXPLORE_OUT || join(process.cwd(), "out", "adhoc");

export default defineConfig({
  testDir: "journeys",
  workers: 1,
  fullyParallel: false,
  timeout: 60 * 60 * 1000,
  expect: { timeout: 20000 },
  outputDir: join(out, "artifacts"),
  reporter: [["list"], ["html", { open: "never", outputFolder: join(out, "report") }]],
  use: { trace: process.env.EXPLORE_FAST === "1" ? "off" : "retain-on-failure", actionTimeout: 30000 },
});
