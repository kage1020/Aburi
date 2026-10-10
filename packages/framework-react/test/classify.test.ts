import { describe, expect, it } from "vitest"
import { classifyReactSymbol } from "../src/index"
import { candidateNamed, makeCandidate, makeCtx } from "./fixtures/symbol"

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
