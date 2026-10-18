import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { reactFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("react-scan")

describe("scan — React source shapes across .tsx and .jsx files", () => {
  it("classifies each React shape, and leaves a helper beside them alone", async () => {
    const files: Record<string, string> = {
      "src/Button.tsx":
        "export function Button({ label }: { label: string }) {\n  return <button>{label}</button>\n}\n",
      "src/hooks.tsx":
        "export function useCounter() {\n  const [c, setC] = useState(0)\n  return { c, inc: () => setC(c + 1) }\n}\n",
      "src/context.tsx":
        "import { createContext } from 'react'\nexport const ThemeCtx = createContext(null)\n",
      "src/forward.tsx":
        "export const FancyBtn = React.forwardRef((p, ref) => <button ref={ref} />)\n",
      "src/memo.tsx":
        "export const Cell = React.memo(function Cell(props) { return <td>{props.v}</td> })\n",
      "src/provider.tsx":
        "export function ThemeProvider({ children }) { return <ThemeCtx.Provider value={'dark'}>{children}</ThemeCtx.Provider> }\n",
      "src/withAuth.tsx":
        "export function withAuth(Component) { return function Wrapped(p) { return <Component {...p} /> } }\n",
      "src/legacy.jsx": "export function OldButton() { return <button>legacy</button> }\n",
      "src/format.tsx": "export function formatDate(d: Date) { return d.toISOString() }\n",
    }
    for (const [path, source] of Object.entries(files)) await workspace.writeSource(path, source)

    const { ir } = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })
    const extKinds = Object.fromEntries(ir.symbols.map((symbol) => [symbol.name, symbol.extKind]))

    expect(extKinds).toMatchObject({
      Button: "framework:react:component",
      useCounter: "framework:react:hook",
      ThemeCtx: "framework:react:context",
      FancyBtn: "framework:react:forward-ref",
      Cell: "framework:react:memo",
      ThemeProvider: "framework:react:provider",
      withAuth: "framework:react:hoc",
      OldButton: "framework:react:component",
      formatDate: null,
    })
  })

  it("gives a const a context, memo or forward-ref role only when its own initializer is that call", async () => {
    await workspace.writeSource(
      "src/ui.tsx",
      [
        `import { createContext, forwardRef, memo } from "react"`,
        `export const ThemeContext = createContext("light"), DEFAULT_THEME = "light"`,
        `export const PAGE_SIZE = 20, Row = memo((props: { id: string }) => <li>{props.id}</li>)`,
        `export const routes = [{ path: "/", element: memo(() => <div />) }]`,
        `export const handlers = { save: () => forwardRef(() => null) }`,
        `export const label = String(42)`,
      ].join("\n"),
    )

    const { ir } = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })
    const consts = ir.symbols.filter((symbol) => symbol.kind === "const")

    expect(Object.fromEntries(consts.map((symbol) => [symbol.name, symbol.extKind]))).toEqual({
      ThemeContext: "framework:react:context",
      DEFAULT_THEME: null,
      PAGE_SIZE: null,
      Row: "framework:react:memo",
      routes: null,
      handlers: null,
      label: null,
    })
  })
})

describe("scan — a wrapper call's derivedBy", () => {
  /** `"<extKind> <the plugin's derivedBy entries>"` for a const `X` that `initializer` initialises. */
  async function classifiedConst(initializer: string): Promise<string> {
    await workspace.writeSource("src/x.tsx", `export const X = ${initializer}\n`)
    const { ir } = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })
    const symbol = ir.symbols.find((s) => s.name === "X")
    if (symbol === undefined) throw new Error("no Symbol named X")
    // The scan appends the framework plugin's entries after the language plugin's.
    const own = symbol.derivedBy.findIndex((entry) => entry.startsWith("framework:react:"))
    return [symbol.extKind, ...(own < 0 ? [] : symbol.derivedBy.slice(own))].join(" ")
  }

  it.each([
    [
      "a memo whose member is wrapped onto a second line",
      "React\n  .memo(Inner)",
      "React.memo(Inner)",
      "framework:react:memo framework:react:memo:React.memo",
    ],
    [
      "a memo whose dot ends a line",
      "React.\n  memo(Inner)",
      "React.memo(Inner)",
      "framework:react:memo framework:react:memo:React.memo",
    ],
    [
      "a context after a comment holding a ;",
      "React /* legacy; see the runbook */ .createContext(null)",
      "React.createContext(null)",
      "framework:react:context framework:react:context:React.createContext",
    ],
    [
      "a forwardRef on a receiver cast to its type",
      "(React as any).forwardRef((p, r) => <b ref={r} />)",
      "React.forwardRef((p, r) => <b ref={r} />)",
      "framework:react:forward-ref framework:react:forward-ref:React.forwardRef",
    ],
  ])("names %s as its one-line spelling does", async (_label, written, oneLine, expected) => {
    expect(await classifiedConst(written)).toBe(expected)
    expect(await classifiedConst(oneLine)).toBe(expected)
  })

  it("names a receiver that is a call by the name the call is made through", async () => {
    expect(await classifiedConst("loadReact().memo(Inner)")).toBe(
      "framework:react:memo framework:react:memo:loadReact.memo",
    )
  })

  it("names a receiver that is not a name as computed", async () => {
    expect(await classifiedConst("new Registry().memo(Inner)")).toBe(
      "framework:react:memo framework:react:memo:<computed>.memo",
    )
  })
})
