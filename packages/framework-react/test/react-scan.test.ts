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

  it("classifies a provider by every element it returns, while a guarded layout and a helper's provider stay components", async () => {
    await workspace.writeSource(
      "src/auth.tsx",
      [
        'import { createContext, useState, type ReactNode } from "react"',
        'import { Spinner } from "./spinner"',
        "",
        "type User = { id: string }",
        "export const AuthContext = createContext<User | null>(null)",
        "",
        "export function AuthProvider({ children }: { children: ReactNode }) {",
        "  const [user] = useState<User | null | undefined>(undefined)",
        "  if (user === undefined) return <Spinner />",
        "  return <AuthContext.Provider value={user}>{children}</AuthContext.Provider>",
        "}",
        "",
        "export function GuardNull({ children }: { children: ReactNode }) {",
        "  const [user] = useState<User | null | undefined>(undefined)",
        "  if (user === undefined) return null",
        "  return <AuthContext.Provider value={user}>{children}</AuthContext.Provider>",
        "}",
        "",
        "export const ParenArrow = ({ children }: { children: ReactNode }) => (",
        "  <AuthContext.Provider value={null}>{children}</AuthContext.Provider>",
        ")",
        "",
        "export function Conditional({ children, loading }: { children: ReactNode; loading: boolean }) {",
        "  const [user] = useState<User | null>(null)",
        "  return loading ? <Spinner /> : <AuthContext.Provider value={user}>{children}</AuthContext.Provider>",
        "}",
        "",
        "export function Gate({ children }: { children: ReactNode }) {",
        "  const [user] = useState<User | null | undefined>(undefined)",
        "  if (user === undefined) return <Spinner />",
        "  return <main>{children}</main>",
        "}",
        "",
        "export function Badge({ user }: { user: User }) {",
        "  const provide = (node: ReactNode) => <AuthContext.Provider value={user}>{node}</AuthContext.Provider>",
        "  return <span>{provide(user.id)}</span>",
        "}",
        "",
      ].join("\n"),
    )

    const { ir } = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })
    const extKinds = Object.fromEntries(ir.symbols.map((symbol) => [symbol.name, symbol.extKind]))

    expect(extKinds).toMatchObject({
      AuthProvider: "framework:react:provider",
      GuardNull: "framework:react:provider",
      ParenArrow: "framework:react:provider",
      Conditional: "framework:react:provider",
      Gate: "framework:react:component",
      Badge: "framework:react:component",
    })
  })
})
