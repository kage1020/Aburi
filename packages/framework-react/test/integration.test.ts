import {
  extractSymbols as extractTypescriptSymbols,
  parseTypescriptFile,
} from "@aburi/lang-typescript"
import type { ExtractionContext, SourceFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { classifyReactSymbol } from "../src/index"

/**
 * End-to-end: parse real TSX with `@aburi/lang-typescript`, run `classifyReactSymbol` on
 * every SymbolCandidate the language plugin emits, and confirm the framework plugin
 * assigns the expected `framework:react:*` extKinds. Locks the wire between AST
 * extraction and framework classification.
 */

async function classifyEach(path: string, source: string) {
  const parseResult = await parseTypescriptFile({ path, content: source })
  const tree = parseResult.tree
  if (tree === null) throw new Error("parse returned null")
  const file: SourceFile = { path, content: source }
  const ctx: ExtractionContext = {
    file,
    registry: {
      findEffect: () => null,
      findExtKind: () => null,
      findFramework: () => null,
      findDerivedByOwner: () => null,
      isEffectOwnedBy: () => false,
      isExtKindOwnedBy: () => false,
      listEffects: () => [],
      listExtKinds: () => [],
      listFrameworks: () => [],
      listPlugins: () => [],
      assertEffectDeclared: () => {},
      assertExtKindDeclared: () => {},
    },
    config: {},
  }
  const candidates = extractTypescriptSymbols(tree, ctx)
  return candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    kind: candidate.kind,
    classification: classifyReactSymbol(candidate, ctx),
  }))
}

describe("integration — lang-typescript → framework-react", () => {
  it("classifies a PascalCase function returning JSX as framework:react:component", async () => {
    const results = await classifyEach(
      "src/Button.tsx",
      "export function Button({ label }: { label: string }) {\n  return <button>{label}</button>\n}",
    )
    const button = results.find((r) => r.name === "Button")
    expect(button?.classification?.extKind).toBe("framework:react:component")
  })

  it("classifies a use* function as framework:react:hook", async () => {
    const results = await classifyEach(
      "src/hooks.tsx",
      "export function useCounter() { const [c, setC] = useState(0); return { c, inc: () => setC(c + 1) } }",
    )
    const hook = results.find((r) => r.name === "useCounter")
    expect(hook?.classification?.extKind).toBe("framework:react:hook")
    expect(hook?.classification?.derivedBy).toBe(
      "framework:react:hook:naming;framework:react:hook:hook-call",
    )
  })

  it("classifies createContext as framework:react:context", async () => {
    const results = await classifyEach(
      "src/ThemeCtx.tsx",
      "import { createContext } from 'react'\nexport const ThemeCtx = createContext<string | null>(null)",
    )
    const ctx = results.find((r) => r.name === "ThemeCtx")
    expect(ctx?.classification?.extKind).toBe("framework:react:context")
    expect(ctx?.classification?.derivedBy).toBe("framework:react:context:createContext")
  })

  it("classifies forwardRef as framework:react:forward-ref", async () => {
    const results = await classifyEach(
      "src/Btn.tsx",
      "export const Btn = React.forwardRef<HTMLButtonElement, {}>((p, ref) => <button ref={ref} />)",
    )
    const btn = results.find((r) => r.name === "Btn")
    expect(btn?.classification?.extKind).toBe("framework:react:forward-ref")
    expect(btn?.classification?.derivedBy).toBe("framework:react:forward-ref:React.forwardRef")
  })

  it("classifies memo as framework:react:memo", async () => {
    const results = await classifyEach(
      "src/Cell.tsx",
      "export const Cell = memo(function Cell(props: { v: number }) { return <td>{props.v}</td> })",
    )
    // The wrapper is a Cell const; the inner function is nested inside memo() and is not
    // extracted as a top-level Symbol.
    const cell = results.find((r) => r.name === "Cell" && r.kind === "const")
    expect(cell?.classification?.extKind).toBe("framework:react:memo")
  })

  it("classifies a <X.Provider>-returning component as framework:react:provider", async () => {
    const results = await classifyEach(
      "src/ThemeProvider.tsx",
      "export function ThemeProvider({ children }: { children: any }) { return <ThemeCtx.Provider value={'dark'}>{children}</ThemeCtx.Provider> }",
    )
    const provider = results.find((r) => r.name === "ThemeProvider")
    expect(provider?.classification?.extKind).toBe("framework:react:provider")
  })

  it("classifies a with* function as framework:react:hoc", async () => {
    const results = await classifyEach(
      "src/withAuth.tsx",
      "export function withAuth<P>(Component: any) { return function Wrapped(props: P) { return <Component {...props} /> } }",
    )
    const hoc = results.find((r) => r.name === "withAuth")
    expect(hoc?.classification?.extKind).toBe("framework:react:hoc")
  })

  it("returns null for non-React helpers colocated in a TSX file", async () => {
    const results = await classifyEach(
      "src/mixed.tsx",
      "export function formatDate(d: Date) { return d.toISOString() }\nexport function Widget() { return <div /> }",
    )
    const helper = results.find((r) => r.name === "formatDate")
    const widget = results.find((r) => r.name === "Widget")
    expect(helper?.classification).toBeNull()
    expect(widget?.classification?.extKind).toBe("framework:react:component")
  })

  it("classifies an arrow-assigned const component as framework:react:component", async () => {
    const results = await classifyEach("src/Arrow.tsx", "export const Arrow = () => <div>hi</div>")
    const arrow = results.find((r) => r.name === "Arrow")
    expect(arrow?.classification?.extKind).toBe("framework:react:component")
  })
})
