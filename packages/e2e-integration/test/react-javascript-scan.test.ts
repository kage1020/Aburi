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
 * a React app whose sources are `.js` — a `create-next-app` JavaScript project, or a CRA app.
 *
 * A grammar that refuses JSX recovers past it, so the file still reached the IR and the
 * declarations mostly survived. What did not: the JSX a classifier reads to recognise a
 * component, every call written inside the markup, and a clean parse-error count — the one
 * signal a reader has that a Symbol set may be short.
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
      "  return <main onClick={() => track(inc)}>{format(c)}</main>",
      "}",
      "",
    ])
    await writeSource("app/legacy.mjs", [
      "export function OldButton() { return <button>legacy</button> }",
      "",
    ])
  })

  it("classifies a component written in a .js file", async () => {
    // The claim the JavaScript coverage exists for. A component is recognised by the JSX it
    // returns, so under a grammar that refuses JSX all three of these were `null`; `OldButton`
    // had no Symbol at all, because nothing survived recovery on a one-line file.
    const result = await scanWorkspace()
    const byName = new Map(result.ir.symbols.map((s) => [s.name, s]))

    expect(byName.get("RootLayout")?.extKind).toBe("framework:react:component")
    expect(byName.get("Home")?.extKind).toBe("framework:react:component")
    expect(byName.get("OldButton")?.extKind).toBe("framework:react:component")
    // A sanity check rather than a guard: a hook is classified by its name, so this one
    // passed before the routing changed too.
    expect(byName.get("useCounter")?.extKind).toBe("framework:react:hook")
  })

  it("walks the calls written inside the markup", async () => {
    // `useCounter` is before the first tag and survived recovery either way. `track` and
    // `format` are inside the JSX, which is where the calls actually went missing.
    //
    // Sorted, because two calls on one line reach the IR in an order this test has no reason
    // to hold. The plugin's own source order is pinned in `javascript-with-jsx.test.ts`.
    const result = await scanWorkspace()
    const home = result.ir.symbols.find((s) => s.name === "Home")

    expect(home?.calls.map((c) => c.target).sort()).toEqual(["format", "track", "useCounter"])
  })

  it("reports no parse error, so the files are not counted as doubtful", async () => {
    // A recoverable error leaves the file in the IR rather than in `stats.skippedFiles`, so
    // the parse-error count is the only thing that says the Symbol set may be short. A React
    // app in JavaScript used to contribute every one of its files to that count.
    const result = await scanWorkspace()

    expect(result.parseErrors).toEqual([])
    // A sanity check: a recoverable error never withdrew the file, so this held before too.
    expect(result.skipped).toEqual([])
  })
})
