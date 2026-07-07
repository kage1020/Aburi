import { defineConfig } from "tsdown"

/**
 * Two entry points: the public library surface (`index.ts` — parsers, argv splitter, and
 * every command handler exported so tests can drive them without shelling out) and the
 * bin file that boots the actual `aburi` binary. `tsdown` inserts the `#!/usr/bin/env
 * node` shebang for the bin entry when the file starts with the marker.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/bin/aburi.ts"],
  format: ["esm"],
  outDir: "dist",
  dts: { isolatedDeclarations: false },
  clean: true,
  sourcemap: false,
  minify: false,
})
