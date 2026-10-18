import { describe, expect, it } from "vitest"
import { classifyReactSymbol } from "../src/index"
import { candidateNamed, candidatesOf, makeCandidate, makeCtx } from "./fixtures/symbol"

async function classified(source: string, name: string) {
  return classifyReactSymbol(await candidateNamed(source, name), makeCtx("src/f.tsx", source))
}

describe("classifyReactSymbol", () => {
  it.each([
    [
      "a use* function",
      "export function useThing() { return 1 }",
      "useThing",
      "hook",
      "hook:naming",
    ],
    [
      "a use* function that calls another hook",
      "export function useCounter() { const [c] = useState(0); return c }",
      "useCounter",
      "hook",
      "hook:naming;framework:react:hook:hook-call",
    ],
    [
      "a use* function that returns JSX",
      "export function useOverlay() { return <div /> }",
      "useOverlay",
      "hook",
      "hook:naming",
    ],
    [
      "an arrow-assigned use* function",
      "export const useThing = () => 42",
      "useThing",
      "hook",
      "hook:naming",
    ],
    [
      "a with* function",
      "export function withAuth(Component) { return function Wrapped(p) { return <Component {...p} /> } }",
      "withAuth",
      "hoc",
      "hoc:naming",
    ],
    [
      "a const holding createContext(...)",
      "export const Ctx = createContext(null)",
      "Ctx",
      "context",
      "context:createContext",
    ],
    [
      "a const holding React.createContext(...)",
      "export const Ctx = React.createContext(null)",
      "Ctx",
      "context",
      "context:React.createContext",
    ],
    [
      "a const holding forwardRef(...)",
      "export const Btn = forwardRef((p, r) => <button ref={r} />)",
      "Btn",
      "forward-ref",
      "forward-ref:forwardRef",
    ],
    [
      "a const holding React.memo(...)",
      "export const M = React.memo(Inner)",
      "M",
      "memo",
      "memo:React.memo",
    ],
    [
      "a const holding memo(forwardRef(...)), by its outer call",
      "export const Nested = React.memo(React.forwardRef((p, ref) => <button ref={ref} />))",
      "Nested",
      "memo",
      "memo:React.memo",
    ],
    [
      "a PascalCase function returning <X.Provider>",
      "export function ThemeProvider({ children }) { return <ThemeCtx.Provider value={null}>{children}</ThemeCtx.Provider> }",
      "ThemeProvider",
      "provider",
      "provider",
    ],
    [
      "a PascalCase function returning JSX",
      "export function Section({ children }) { return <section>{children}</section> }",
      "Section",
      "component",
      "component",
    ],
    [
      "an arrow-assigned PascalCase function returning JSX",
      "export const MyComp = () => <div />",
      "MyComp",
      "component",
      "component",
    ],
  ])("classifies %s", async (_label, source, name, kind, tag) => {
    expect(await classified(source, name)).toEqual({
      extKind: `framework:react:${kind}`,
      derivedBy: `framework:react:${tag}`,
    })
  })

  it.each([
    ["a plain utility", "export function helper(x: number) { return x + 1 }", "helper"],
    [
      "a PascalCase function that never returns JSX",
      "export function BuildQuery() { return { where: {} } }",
      "BuildQuery",
    ],
    ["a const no wrapper initializes", "export const V = 42", "V"],
    [
      "an anonymous default export, whose name is not PascalCase",
      "export default function() { return <div /> }",
      "<default>",
    ],
  ])("returns null for %s", async (_label, source, name) => {
    expect(await classified(source, name)).toBeNull()
  })

  it.each([
    "class",
    "method",
    "interface",
    "type",
    "enum",
    "namespace",
  ] as const)("returns null for a %s", (kind) => {
    expect(classifyReactSymbol(makeCandidate({ kind, name: "X" }), makeCtx())).toBeNull()
  })
})

describe("classifyReactSymbol — a const read from its own initializer", () => {
  /** `"<name> <extKind> <derivedBy>"` per const Symbol, `"<name> -"` for one with no role, sorted. */
  async function constRoles(source: string): Promise<string[]> {
    const ctx = makeCtx("src/f.tsx", source)
    return (await candidatesOf(source))
      .filter((candidate) => candidate.kind === "const")
      .map((candidate) => {
        const role = classifyReactSymbol(candidate, ctx)
        return role === null
          ? `${candidate.name} -`
          : `${candidate.name} ${role.extKind} ${role.derivedBy}`
      })
      .sort()
  }

  it.each([
    [
      "a wrapper declared first",
      `export const ThemeContext = createContext("light"), DEFAULT_THEME = "light"`,
      [
        "DEFAULT_THEME -",
        "ThemeContext framework:react:context framework:react:context:createContext",
      ],
    ],
    [
      "a wrapper declared second",
      "export const PAGE_SIZE = 20, Row = memo((props: { id: string }) => <li>{props.id}</li>)",
      ["PAGE_SIZE -", "Row framework:react:memo framework:react:memo:memo"],
    ],
    [
      "a wrapper declared after another call",
      "export const theme = getTheme(), Ctx = createContext(null)",
      ["Ctx framework:react:context framework:react:context:createContext", "theme -"],
    ],
    [
      "two wrappers",
      "export const A = memo(X), B = React.forwardRef(Y)",
      [
        "A framework:react:memo framework:react:memo:memo",
        "B framework:react:forward-ref framework:react:forward-ref:React.forwardRef",
      ],
    ],
    [
      "memo(forwardRef(...)) declared second",
      "export const size = 1, Fancy = memo(forwardRef((p, r) => <b ref={r} />))",
      ["Fancy framework:react:memo framework:react:memo:memo", "size -"],
    ],
    [
      "a wrapper declared second in a namespace",
      "export namespace ui {\n  export const size = 1, Row = memo(Inner)\n}",
      ["ui.Row framework:react:memo framework:react:memo:memo", "ui.size -"],
    ],
    [
      "a wrapper beside a call that wraps one",
      "export const Row = memo(Impl), Themed = withTheme(memo(Impl))",
      ["Row framework:react:memo framework:react:memo:memo", "Themed -"],
    ],
  ])("gives each name in a statement its own role: %s", async (_label, source, roles) => {
    expect(await constRoles(source)).toEqual(roles)
  })

  it.each([
    [
      "nested in an array",
      `export const routes = [{ path: "/", element: memo(() => <div />) }]`,
      "routes",
    ],
    [
      "inside an object literal's function",
      "export const handlers = { save: () => forwardRef(() => null) }",
      "handlers",
    ],
    ["as an object literal's value", "export const views = { list: memo(List) }", "views"],
    ["handed to `new`", "export const holder = new Holder(memo(Impl))", "holder"],
    ["in one branch of a conditional", "export const Row = flag ? memo(Impl) : Impl", "Row"],
  ])("gives no role to a const holding a wrapper %s", async (_label, source, name) => {
    expect(await constRoles(source)).toEqual([`${name} -`])
  })

  it("gives no role to a name destructured from a wrapper call", async () => {
    expect(await constRoles("export const { displayName } = memo(Impl)")).toEqual(["displayName -"])
  })

  it.each([
    ["`as`", "export const Row = memo(Impl) as typeof Impl"],
    ["`satisfies`", "export const Row = memo(Impl) satisfies ComponentType"],
    ["`!`", "export const Row = memo(Impl)!"],
    ["parentheses", "export const Row = (memo(Impl))"],
  ])("reads a wrapper through %s", async (_label, source) => {
    expect(await constRoles(source)).toEqual(["Row framework:react:memo framework:react:memo:memo"])
  })
})
