import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/bin/aburi-mcp.ts"],
  format: ["esm"],
  outDir: "dist",
  dts: { isolatedDeclarations: false },
  clean: true,
  sourcemap: false,
  minify: true,
})
