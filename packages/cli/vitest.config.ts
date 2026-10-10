import { defineConfig, mergeConfig } from "vitest/config"
import shared from "../../vitest.shared.ts"

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // test/e2e runs real git, tree-sitter and language servers.
      testTimeout: 60_000,
    },
  }),
)
