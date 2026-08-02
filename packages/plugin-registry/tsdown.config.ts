import { defineConfig } from "tsdown"

export default defineConfig({
  // Two entries, not one barrel: `src/index.ts` compiles the plugin JSON Schema with ajv at
  // module scope, and effect plugins that only want the input guards must not pay for that
  // at import time. Keeping `plugin-input` a separate chunk is what makes the
  // `@aburi/plugin-registry/plugin-input` subpath ajv-free.
  entry: ["src/index.ts", "src/plugin-input.ts"],
  format: ["esm"],
  outDir: "dist",
  dts: { isolatedDeclarations: false },
  clean: true,
  sourcemap: false,
  minify: false,
})
