import { reactFrameworkPlugin } from "@aburi/framework-react"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { beforeEach, describe, expect, it } from "vitest"
import { scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * The reason the JavaScript extensions are covered at all: a React app whose sources are
 * `.js` — a `create-next-app` JavaScript project, or a CRA app.
 *
 * A grammar that refuses JSX recovers past it, so the file still reached the IR and the
 * declarations mostly survived. What did not: the JSX a classifier reads to recognise a
 * component, every call written inside the markup, and a clean parse-error count — the one
 * signal a reader has that a Symbol set may be short.
 */

const workspace = useScratchWorkspace("react-js")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [reactFrameworkPlugin],
  })

describe("scan — a React app written in plain JavaScript", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "app/layout.js",
      [
        'import "./globals.css"',
        "",
        "export default function RootLayout({ children }) {",
        '  return <html lang="en"><body>{children}</body></html>',
        "}",
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "app/page.js",
      [
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
      ].join("\n"),
    )
    await workspace.writeSource(
      "app/legacy.mjs",
      ["export function OldButton() { return <button>legacy</button> }", ""].join("\n"),
    )
  })

  it("classifies a component written in a .js file", async () => {
    // A component is recognised by the JSX it returns, so under a grammar that refuses JSX all
    // three of these were `null`; `OldButton` had no Symbol at all, because nothing survived
    // recovery on a one-line file.
    const result = await scanWorkspace()
    const byName = new Map(result.ir.symbols.map((symbol) => [symbol.name, symbol]))

    expect(byName.get("RootLayout")?.extKind).toBe("framework:react:component")
    expect(byName.get("Home")?.extKind).toBe("framework:react:component")
    expect(byName.get("OldButton")?.extKind).toBe("framework:react:component")
    // A hook is classified by its name, so this one passed before the routing changed too.
    expect(byName.get("useCounter")?.extKind).toBe("framework:react:hook")
  })

  it("walks the calls written inside the markup", async () => {
    // `useCounter` is before the first tag and survived recovery either way. `track` and
    // `format` are inside the JSX, which is where the calls actually went missing.
    //
    // Sorted, because two calls on one line reach the IR in an order this test has no reason
    // to hold. The plugin's own source order is pinned in `javascript-with-jsx.test.ts`.
    const result = await scanWorkspace()
    const home = result.ir.symbols.find((symbol) => symbol.name === "Home")

    expect(home?.calls.map((c) => c.target).sort()).toEqual(["format", "track", "useCounter"])
  })

  it("reports no parse error, so the files are not counted as doubtful", async () => {
    // A recoverable error leaves the file in the IR rather than in `stats.skippedFiles`, so
    // the parse-error count is the only thing that says the Symbol set may be short.
    const result = await scanWorkspace()

    expect(result.parseErrors).toEqual([])
    expect(result.skipped).toEqual([])
  })
})
