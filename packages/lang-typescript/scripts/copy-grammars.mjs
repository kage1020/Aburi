/**
 * Vendors the two tree-sitter grammar wasms this plugin actually parses with into the
 * package's own `wasm/` directory.
 *
 * `@vscode/tree-sitter-wasm` ships 16 grammars totalling ~21 MB — bash, C#, C++, Ruby,
 * Rust, PHP, PowerShell and the rest — of which this plugin loads exactly two. npm has no
 * way to install part of a tarball, so depending on it at runtime bills every consumer
 * ~19 MB for grammars that are never read. Keeping it a devDependency and copying the two
 * files we need turns that into the ~2.7 MB we do use.
 *
 * The destination is the package root rather than `dist/` so that one relative path,
 * `../wasm/`, resolves for both `dist/index.mjs` (published) and `src/parser.ts` (tests,
 * which import the sources directly). Both live exactly one directory below the package
 * root; `parser.ts` states that dependency where it builds the paths.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const destinationDir = join(packageRoot, "wasm")

/** Grammar wasms `src/parser.ts` dispatches to, by `EXTENSION_GRAMMAR`. */
const GRAMMARS = ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]

/**
 * Copy one grammar, skipping the write when the destination already matches the source
 * byte count. `build` and `test` both call this script, and on a warm tree that check
 * keeps the no-op case to a pair of stats instead of ~2.7 MB of I/O.
 */
async function copyGrammar(name) {
  const source = require.resolve(`@vscode/tree-sitter-wasm/wasm/${name}`)
  const destination = join(destinationDir, name)
  const [sourceStat, destinationStat] = await Promise.all([
    stat(source),
    stat(destination).catch(() => null),
  ])
  if (destinationStat !== null && destinationStat.size === sourceStat.size) return false
  await copyFile(source, destination)
  return true
}

/**
 * Record where the vendored binaries came from. The wasm files are build output rather
 * than sources, so the attribution their MIT licence asks for cannot live in a header
 * comment inside them — it lives beside them, and ships in the tarball with them.
 */
async function writeAttribution() {
  const { version } = require("@vscode/tree-sitter-wasm/package.json")
  const licence = await readFile(require.resolve("@vscode/tree-sitter-wasm/LICENSE"), "utf8")
  const header = [
    "The .wasm files in this directory are prebuilt tree-sitter grammars copied verbatim",
    `from @vscode/tree-sitter-wasm@${version} at build time. They are not Aburi sources.`,
    "",
    "Upstream: https://github.com/microsoft/vscode-tree-sitter-wasm",
    "Grammars: tree-sitter-typescript, tree-sitter-tsx (tree-sitter, MIT)",
    "",
    "Regenerate with `pnpm --filter @aburi/lang-typescript build`; bump the grammars by",
    "bumping the @vscode/tree-sitter-wasm devDependency.",
    "",
    "--- upstream LICENSE ---",
    "",
    licence.trimEnd(),
    "",
  ].join("\n")
  await writeFile(join(destinationDir, "NOTICE"), header)
}

await mkdir(destinationDir, { recursive: true })
const copied = await Promise.all(GRAMMARS.map(copyGrammar))
await writeAttribution()
console.log(
  copied.some(Boolean)
    ? `vendored ${GRAMMARS.length} tree-sitter grammars into wasm/`
    : `wasm/ already holds the ${GRAMMARS.length} tree-sitter grammars`,
)
