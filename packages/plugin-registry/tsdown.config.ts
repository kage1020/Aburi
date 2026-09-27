import { defineConfig } from "tsdown"

export default defineConfig({
  // Separate entries, not one barrel: `src/index.ts` compiles the plugin JSON Schema with ajv at
  // module scope, and effect plugins that only want the input guards, or `@aburi/config` that
  // only wants the key scan, must not pay for that at import time. Keeping each a separate chunk
  // is what makes the `/plugin-input` and `/repeated-keys` subpaths ajv-free.
  entry: ["src/index.ts", "src/plugin-input.ts", "src/repeated-keys.ts"],
  format: ["esm"],
  outDir: "dist",
  dts: { isolatedDeclarations: false },
  clean: true,
  sourcemap: false,
  minify: true,
})
