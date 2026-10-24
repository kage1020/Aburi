import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { frameworkEntries, symbolNamed, useScratchWorkspace } from "@aburi/test-support"
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

describe("scan — a call's derivedBy", () => {
  /** `"<extKind> <the plugin's derivedBy entries>"` for the Symbol `name` that `source` declares. */
  async function classified(source: string, name: string): Promise<string> {
    await workspace.writeSource("src/x.tsx", source)
    const result = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })
    const symbol = symbolNamed(result, name)
    return [symbol.extKind, ...frameworkEntries(symbol, "framework:react:")].join(" ")
  }

  const classifiedConst = (initializer: string) =>
    classified(`export const X = ${initializer}\n`, "X")
  const classifiedHook = (returned: string) =>
    classified(`export function useCounter() {\n  return ${returned}\n}\n`, "useCounter")

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

  it.each([
    ["whose dot ends a line", "React.\n    useState(0)"],
    ["with a comment after its dot", "React./* a */useState(0)"],
  ])("finds a hook call %s as its one-line spelling does", async (_label, written) => {
    const expected =
      "framework:react:hook framework:react:hook:naming framework:react:hook:hook-call"
    expect(await classifiedHook(written)).toBe(expected)
    expect(await classifiedHook("React.useState(0)")).toBe(expected)
  })

  it.each([
    [
      "a call by the name the call is made through",
      "loadReact().memo(Inner)",
      "framework:react:memo framework:react:memo:loadReact.memo",
    ],
    [
      "something that is not a name as computed",
      "new Registry().memo(Inner)",
      "framework:react:memo framework:react:memo:<computed>.memo",
    ],
  ])("names a receiver that is %s", async (_label, initializer, expected) => {
    expect(await classifiedConst(initializer)).toBe(expected)
  })
})
