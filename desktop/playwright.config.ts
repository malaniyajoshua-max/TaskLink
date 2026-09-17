import { defineConfig } from "@playwright/test";
import path from "node:path";
export default defineConfig({
  testDir: "e2e",
  timeout: 90000,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  outputDir: path.resolve("../work/playwright-results"),
  use: { trace: "retain-on-failure" },
});
