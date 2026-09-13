/**
 * Vendors the tree-sitter grammar wasms this plugin parses with into the package's own
 * `wasm/` directory, and writes the attribution that has to travel with them.
 *
 * This plugin reads two of the grammars `@vscode/tree-sitter-wasm` ships. npm cannot
 * install part of a tarball, so keeping it a runtime dependency would put all the others
 * on every consumer's disk unread — hence a devDependency plus this copy. The measured
 * sizes behind that decision are in the changeset, where they stay true to their date.
 *
 * The destination is the package root rather than `dist/` so that one relative path,
 * `../wasm/`, resolves for both `dist/index.mjs` (published) and `src/parser.ts` (tests,
 * which import the sources directly). Both live exactly one directory below the package
 * root; `parser.ts` states that dependency where it builds the paths.
 *
 * Runs from two places — the package's `build` script, and vitest's `globalSetup`, so
 * that `vitest --watch`, a single-file run and the editor extension all provision the
 * grammars rather than failing on a missing file. Those can run concurrently, so every
 * write lands through a temporary file and a rename.
 */
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const destinationDir = join(packageRoot, "wasm")

/**
 * Grammar wasms `EXTENSION_GRAMMAR` in `src/parser.ts` dispatches to.
 *
 * This list and the two `new URL()` literals over there are necessarily separate: those
 * have to stay literals for a bundler to treat them as assets, so they cannot read a
 * shared constant. `test/vendored-grammars.test.ts` in `@aburi/e2e-integration` asserts
 * that every path the parser resolves exists, which is what catches the two drifting.
 */
const GRAMMARS = ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")

/**
 * Read a file, distinguishing "not written yet" from every other failure.
 *
 * Only ENOENT means the destination is absent. EACCES on a `wasm/` restored from a CI
 * cache under another owner, EBUSY from a vitest run holding the file on Windows, EIO on
 * a network drive — collapsing those into "absent" makes the next write fail with a
 * second-order message ("permission denied, copyfile") in place of the one fact the
 * script already had.
 */
async function readIfPresent(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw new Error(
      `copy-grammars: cannot read ${path} (${error.code}). Remove ` +
        `packages/lang-typescript/wasm/ and re-run the build.`,
      { cause: error },
    )
  }
}

/**
 * Write `content` to `destination` unless the identical bytes are already there.
 *
 * Comparing content rather than size is what keeps `NOTICE` honest: a size-only check
 * would let a grammar that changed upstream without changing length stay on disk under a
 * `NOTICE` naming the new version — a false provenance record rather than a stale cache.
 * Since `wasm/` is gitignored, such a file would survive branch switches and `git clean`.
 */
async function writeIfChanged(destination, content) {
  const existing = await readIfPresent(destination)
  if (existing !== null && digest(existing) === digest(content)) return false
  const temporary = `${destination}.${process.pid}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, destination)
  return true
}

/**
 * The attribution that ships beside the binaries.
 *
 * Two separate credits are owed and they are not the same one: the licence text upstream
 * distributes is `@vscode/tree-sitter-wasm`'s own, whose copyright line is Microsoft's,
 * while the grammars are tree-sitter's work. Upstream registers only tree-sitter itself
 * in `cgmanifest.json` and ships no grammar-project licence, so this reproduces that
 * registration verbatim rather than implying a licence text it does not have.
 */
async function buildNotice() {
  const { version } = require("@vscode/tree-sitter-wasm/package.json")
  const { registrations } = require("@vscode/tree-sitter-wasm/cgmanifest.json")
  const licence = await readFile(require.resolve("@vscode/tree-sitter-wasm/LICENSE"), "utf8")

  const registered = registrations.map((entry) => {
    const { name, repositoryUrl, commitHash } = entry.component.git
    return `  ${name} ${entry.version} (${entry.license}) — ${repositoryUrl} @ ${commitHash}`
  })

  return `${[
    "The .wasm files in this directory are prebuilt tree-sitter grammars, copied verbatim",
    `from @vscode/tree-sitter-wasm@${version} at build time by scripts/copy-grammars.mjs.`,
    "They are not Aburi sources.",
    "",
    ...GRAMMARS.map((name) => `  ${name}`),
    "",
    "Upstream: https://github.com/microsoft/vscode-tree-sitter-wasm",
    "",
    "That package's cgmanifest.json registers the following component for the binaries it",
    "ships:",
    "",
    ...registered,
    "",
    "The grammar projects themselves are not separately registered there and their own",
    "licence texts are not in that tarball. The licence reproduced below is therefore",
    "@vscode/tree-sitter-wasm's own, exactly as a consumer received it before Aburi began",
    "redistributing these binaries.",
    "",
    "Regenerate with `pnpm --filter @aburi/lang-typescript build`; bump the grammars by",
    "bumping the @vscode/tree-sitter-wasm devDependency.",
    "",
    "--- @vscode/tree-sitter-wasm LICENSE ---",
    "",
    licence.trimEnd(),
  ].join("\n")}\n`
}

/** Provision `wasm/`, reporting how many files this run actually had to write. */
export default async function vendorGrammars() {
  await mkdir(destinationDir, { recursive: true })

  const written = await Promise.all(
    GRAMMARS.map(async (name) => {
      const source = await readFile(require.resolve(`@vscode/tree-sitter-wasm/wasm/${name}`))
      return writeIfChanged(join(destinationDir, name), source)
    }),
  )
  const noticeWritten = await writeIfChanged(join(destinationDir, "NOTICE"), await buildNotice())

  const count = written.filter(Boolean).length
  console.log(
    count === 0 && !noticeWritten
      ? `wasm/ already holds the ${GRAMMARS.length} tree-sitter grammars`
      : `vendored ${count} tree-sitter grammar(s)${noticeWritten ? " and NOTICE" : ""} into wasm/`,
  )
}

// Also runnable as a plain script, which is how the `build` script invokes it.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await vendorGrammars()
}
