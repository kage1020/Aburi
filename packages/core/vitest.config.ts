import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // `component.test.ts` and `scan/*.test.ts` write dozens of files into a
    // `mkdtemp` sandbox per case. On a cold Windows CI runner (antivirus
    // scans every write) the setup alone can consume the 5 s default before
    // the assertion runs. Every other platform finishes each case in <1 s.
    // 30 s is loose enough that a genuine hang still surfaces.
    testTimeout: 30_000,
  },
})
