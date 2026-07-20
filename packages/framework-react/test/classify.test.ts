import { extractSymbols, parseTypescriptFile } from "@aburi/lang-typescript"
import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { classifyReactSymbol } from "../src/index"
import { makeCandidate, makeCtx } from "./fixtures/symbol"

async function extractFrom(source: string): Promise<SymbolCandidate<unknown>[]> {
  const path = "src/f.tsx"
  const result = await parseTypescriptFile({ path, content: source })
  if (result.tree === null) throw new Error("parse returned null")
  return extractSymbols(result.tree, makeCtx(path, source))
}

/**
 * Find a candidate by name and fail-loud if it is missing. The extractor emits the
 * expected symbol on every test fixture; a missing candidate is a test-fixture bug we
 * want surfaced, not a silent `undefined` propagating into a nullable classification.
 */
function findByName(
  candidates: readonly SymbolCandidate<unknown>[],
  name: string,
): SymbolCandidate<unknown> {
  const hit = candidates.find((c) => c.name === name)
  if (hit === undefined) throw new Error(`no candidate named ${name} in fixture`)
  return hit
}

describe("classifyReactSymbol — dispatcher basics", () => {
  it("returns null for symbol kinds that are not function or const", () => {
    for (const kind of ["class", "method", "interface", "type", "enum", "namespace"] as const) {
      const result = classifyReactSymbol(makeCandidate({ kind, name: "X" }), makeCtx())
      expect(result).toBeNull()
    }
  })

  it("returns null for a plain utility function (no React signal)", async () => {
    const candidates = await extractFrom("export function helper(x: number) { return x + 1 }")
    const helper = findByName(candidates, "helper")
    const result = classifyReactSymbol(helper, makeCtx("src/f.tsx", ""))
    expect(result).toBeNull()
  })
})

describe("classifyReactSymbol — hook priority", () => {
  it("classifies a use* function as hook (naming signal only)", async () => {
    const source = "export function useThing() { return 1 }"
    const candidates = await extractFrom(source)
    const hook = findByName(candidates, "useThing")
    const result = classifyReactSymbol(hook, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:hook")
    expect(result?.derivedBy).toBe("framework:react:hook:naming")
  })

  it("appends hook-call signal when the body calls another hook", async () => {
    const source = "export function useCounter() { const [c] = useState(0); return c }"
    const candidates = await extractFrom(source)
    const hook = findByName(candidates, "useCounter")
    const result = classifyReactSymbol(hook, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:hook")
    expect(result?.derivedBy).toBe("framework:react:hook:naming;framework:react:hook:hook-call")
  })

  it("prefers hook over component even when the hook returns JSX", async () => {
    // Contrived but legal: some hooks return JSX (e.g. useDialog returns a portal element).
    const source = "export function useOverlay() { return <div /> }"
    const candidates = await extractFrom(source)
    const hook = findByName(candidates, "useOverlay")
    const result = classifyReactSymbol(hook, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:hook")
  })
})

describe("classifyReactSymbol — const-wrapper classifications", () => {
  it("classifies createContext as context (bare identifier)", async () => {
    const source = "export const Ctx = createContext(null)"
    const candidates = await extractFrom(source)
    const ctx = findByName(candidates, "Ctx")
    const result = classifyReactSymbol(ctx, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:context")
    expect(result?.derivedBy).toBe("framework:react:context:createContext")
  })

  it("classifies React.createContext as context (member expression)", async () => {
    const source = "export const Ctx = React.createContext(null)"
    const candidates = await extractFrom(source)
    const ctx = findByName(candidates, "Ctx")
    const result = classifyReactSymbol(ctx, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:context")
    expect(result?.derivedBy).toBe("framework:react:context:React.createContext")
  })

  it("classifies forwardRef as forward-ref", async () => {
    const source = "export const Btn = forwardRef((p, r) => <button ref={r} />)"
    const candidates = await extractFrom(source)
    const btn = findByName(candidates, "Btn")
    const result = classifyReactSymbol(btn, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:forward-ref")
    expect(result?.derivedBy).toBe("framework:react:forward-ref:forwardRef")
  })

  it("classifies memo as memo", async () => {
    const source = "export const M = React.memo(Inner)"
    const candidates = await extractFrom(source)
    const m = findByName(candidates, "M")
    const result = classifyReactSymbol(m, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:memo")
    expect(result?.derivedBy).toBe("framework:react:memo:React.memo")
  })

  it("returns null for a const whose initializer is not a known wrapper", async () => {
    const source = "export const V = 42"
    const candidates = await extractFrom(source)
    const v = findByName(candidates, "V")
    const result = classifyReactSymbol(v, makeCtx("src/f.tsx", source))
    expect(result).toBeNull()
  })
})

describe("classifyReactSymbol — component / provider / hoc", () => {
  it("classifies a PascalCase function returning JSX as component", async () => {
    const source = "export function Widget() { return <div /> }"
    const candidates = await extractFrom(source)
    const w = findByName(candidates, "Widget")
    const result = classifyReactSymbol(w, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:component")
    expect(result?.derivedBy).toBe("framework:react:component")
  })

  it("classifies a PascalCase function returning <X.Provider> as provider (wins over component)", async () => {
    const source =
      "export function ThemeProvider({ children }) { return <ThemeCtx.Provider value={null}>{children}</ThemeCtx.Provider> }"
    const candidates = await extractFrom(source)
    const p = findByName(candidates, "ThemeProvider")
    const result = classifyReactSymbol(p, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:provider")
    expect(result?.derivedBy).toBe("framework:react:provider")
  })

  it("does NOT classify a component-shaped function as provider when the top JSX is not X.Provider", async () => {
    const source = "export function Section({ children }) { return <section>{children}</section> }"
    const candidates = await extractFrom(source)
    const s = findByName(candidates, "Section")
    const result = classifyReactSymbol(s, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:component")
  })

  it("classifies a with* function as hoc", async () => {
    const source =
      "export function withAuth(Component) { return function Wrapped(p) { return <Component {...p} /> } }"
    const candidates = await extractFrom(source)
    const hoc = findByName(candidates, "withAuth")
    const result = classifyReactSymbol(hoc, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:hoc")
    expect(result?.derivedBy).toBe("framework:react:hoc:naming")
  })

  it("returns null for a PascalCase function that never returns JSX", async () => {
    const source = "export function BuildQuery() { return { where: {} } }"
    const candidates = await extractFrom(source)
    const q = findByName(candidates, "BuildQuery")
    const result = classifyReactSymbol(q, makeCtx("src/f.tsx", source))
    expect(result).toBeNull()
  })
})

describe("classifyReactSymbol — arrow-assigned function components", () => {
  it("classifies const MyComponent = () => <div /> as component", async () => {
    // lang-typescript emits variable_assigned_function → kind: 'function', name: 'MyComp'.
    const source = "export const MyComp = () => <div />"
    const candidates = await extractFrom(source)
    const c = findByName(candidates, "MyComp")
    expect(c.kind).toBe("function")
    const result = classifyReactSymbol(c, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:component")
  })

  it("classifies const useThing = () => ... as hook (naming beats function-shape)", async () => {
    const source = "export const useThing = () => 42"
    const candidates = await extractFrom(source)
    const h = findByName(candidates, "useThing")
    const result = classifyReactSymbol(h, makeCtx("src/f.tsx", source))
    expect(result?.extKind).toBe("framework:react:hook")
  })
})
