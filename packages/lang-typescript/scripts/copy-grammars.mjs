import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const destinationDir = join(packageRoot, "wasm")

const GRAMMARS = ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")

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

async function writeIfChanged(destination, content) {
  const existing = await readIfPresent(destination)
  if (existing !== null && digest(existing) === digest(content)) return false
  const temporary = `${destination}.${process.pid}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, destination)
  return true
}

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
