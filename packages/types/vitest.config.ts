import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // `codegen-drift.test.ts` runs the full codegen (JST + AJV schema traversal
    // + write to memory) up to twice per case. On a cold Windows CI runner the
    // first invocation can push past the 5 s default; every stress test since
    // that suite landed has been benign in that regard except on Windows.
    // A generous cap avoids flakes without hiding a real hang.
    testTimeout: 30_000,
  },
})
