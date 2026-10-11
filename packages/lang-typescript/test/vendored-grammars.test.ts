import { execFile } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"

const run = promisify(execFile)
const require = createRequire(import.meta.url)

const SCRIPT = fileURLToPath(new URL("../scripts/copy-grammars.mjs", import.meta.url))
const GRAMMARS = ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]
const VENDORED = ["NOTICE", ...GRAMMARS].sort()

interface Registration {
  version: string
  component: { git: { name: string; commitHash: string } }
}

const workspace = useScratchWorkspace("vendored-grammars")

/** Run the build's vendoring step into a directory of this test's own, and return that directory. */
async function vendor(): Promise<string> {
  const destination = join(workspace.root, "wasm")
  await run(process.execPath, [SCRIPT, destination])
  return destination
}

const upstream = (path: string) => require.resolve(`@vscode/tree-sitter-wasm/${path}`)

describe("copy-grammars — the grammars a build vendors", () => {
  it("writes the two grammars byte for byte as upstream ships them, a NOTICE, and nothing else", async () => {
    const destination = await vendor()

    expect((await readdir(destination)).sort()).toEqual(VENDORED)
    for (const name of GRAMMARS) {
      const [vendored, shipped] = await Promise.all([
        readFile(join(destination, name)),
        readFile(upstream(`wasm/${name}`)),
      ])
      expect(vendored.equals(shipped), name).toBe(true)
    }
  })

  it("names in the NOTICE the upstream version it read and every component upstream registers", async () => {
    const { version } = require("@vscode/tree-sitter-wasm/package.json") as { version: string }
    const { registrations } = require("@vscode/tree-sitter-wasm/cgmanifest.json") as {
      registrations: Registration[]
    }

    const notice = await readFile(join(await vendor(), "NOTICE"), "utf8")

    expect(notice).toContain(`@vscode/tree-sitter-wasm@${version}`)
    expect(registrations.length).toBeGreaterThan(0)
    for (const { version: componentVersion, component } of registrations) {
      expect(notice).toContain(`${component.git.name} ${componentVersion}`)
      expect(notice).toContain(component.git.commitHash)
    }
  })

  it("reproduces upstream's licence in the NOTICE verbatim", async () => {
    const licence = await readFile(upstream("LICENSE"), "utf8")

    const notice = await readFile(join(await vendor(), "NOTICE"), "utf8")

    expect(notice.endsWith(`${licence.trimEnd()}\n`)).toBe(true)
  })

  it("rewrites nothing on a second run", async () => {
    const destination = await vendor()
    const mtimes = () =>
      Promise.all(VENDORED.map(async (name) => (await stat(join(destination, name))).mtimeMs))
    const first = await mtimes()

    await vendor()

    expect(await mtimes()).toEqual(first)
    expect((await readdir(destination)).sort()).toEqual(VENDORED)
  })
})
