import { defineConfig } from "@playwright/test";

// Keep test-launched app windows invisible; CDP input needs no visible window.
process.env.LIKEOFFICE_HIDE_WINDOWS = "1";

export default defineConfig({
  testDir: "e2e",
  timeout: 60000,
  workers: 1,
});
