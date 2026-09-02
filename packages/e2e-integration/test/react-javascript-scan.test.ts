import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type ScanResult, scan } from "@aburi/core"
import { reactFrameworkPlugin } from "@aburi/framework-react"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * The reason the JavaScript extensions are covered at all, reached the way it reaches a user:
 * a React app whose sources are `.js` — a `create-next-app` JavaScript project, a CRA app, a
 * library published as plain JavaScript.
 *
 * The components' bodies were unparsed, so nothing was classified and the file still reached
 * the IR: a diff read the Symbols it did not produce as deletions.
 */

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-react-js-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

async function writeSource(rel: string, lines: string[]): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, lines.join("\n"), "utf8")
}

async function scanWorkspace(): Promise<ScanResult> {
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  registry.register(reactFrameworkPlugin.manifest)
  return scan({
    workspaceRoot: workRoot,
    config: {},
    languages: [langTypescriptPlugin],
    frameworks: [reactFrameworkPlugin],
    effects: [],
    registry,
    components: [],
  })
}

describe("scan — a React app written in plain JavaScript", () => {
  beforeEach(async () => {
    await writeSource("app/layout.js", [
      'import "./globals.css"',
      "",
      "export default function RootLayout({ children }) {",
      '  return <html lang="en"><body>{children}</body></html>',
      "}",
      "",
    ])
    await writeSource("app/page.js", [
      'import { useState } from "react"',
      "",
      "export function useCounter() {",
      "  const [c, setC] = useState(0)",
      "  return { c, inc: () => setC(c + 1) }",
      "}",
      "",
      "export function Home() {",
      "  const { c, inc } = useCounter()",
      "  return <main onClick={inc}>{c}</main>",
      "}",
      "",
    ])
    await writeSource("app/legacy.mjs", [
      "export function OldButton() { return <button>legacy</button> }",
      "",
    ])
  })

  it("classifies a component written in a .js file", async () => {
    const result = await scanWorkspace()
    const byName = new Map(result.ir.symbols.map((s) => [s.name, s]))

    expect(byName.get("RootLayout")?.extKind).toBe("framework:react:component")
    expect(byName.get("Home")?.extKind).toBe("framework:react:component")
    expect(byName.get("useCounter")?.extKind).toBe("framework:react:hook")
    expect(byName.get("OldButton")?.extKind).toBe("framework:react:component")
  })

  it("walks the bodies the refusing grammar swallowed", async () => {
    const result = await scanWorkspace()
    const home = result.ir.symbols.find((s) => s.name === "Home")

    expect(home?.calls.map((c) => c.target)).toContain("useCounter")
  })

  it("reports no parse error, so the files are not counted as doubtful", async () => {
    // A recoverable error leaves the file in the IR rather than in `stats.skippedFiles`, so
    // the count is the only thing that says the Symbol set may be short. A React app in
    // JavaScript used to put every one of its files in it.
    const result = await scanWorkspace()

    expect(result.parseErrors).toEqual([])
    expect(result.skipped).toEqual([])
  })
})
