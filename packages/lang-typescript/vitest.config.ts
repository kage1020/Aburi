import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // The tests import `src/` directly, and `src/parser.ts` refuses to load without the
    // grammars in `wasm/` — which is gitignored build output. Provisioning here rather
    // than in the `test` script covers `vitest --watch`, a single-file run and the editor
    // extension, none of which go through package.json.
    globalSetup: ["./scripts/copy-grammars.mjs"],
  },
})
