import { parseTypescriptFile } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { extractWrapperCall, isContextCall, isForwardRefCall, isMemoCall } from "../src/index"

async function parseRoot(source: string): Promise<unknown> {
  const result = await parseTypescriptFile({ path: "src/f.tsx", content: source })
  if (result.tree === null) throw new Error("parse returned null")
  return result.tree.rootNode
}

describe("extractWrapperCall", () => {
  it("returns null for a non-tree-sitter value", () => {
    expect(extractWrapperCall(null)).toBeNull()
    expect(extractWrapperCall({ placeholder: true } as unknown)).toBeNull()
  })

  it("returns null when the const initializer is not a call", async () => {
    const root = await parseRoot("const x = 42")
    expect(extractWrapperCall(root)).toBeNull()
  })

  it("finds the outer wrapping call, not an inner one inside the argument body", async () => {
    // forwardRef(fn) — the inner fn body calls useState; the outer call should still win.
    const root = await parseRoot(
      "const Btn = forwardRef((p, r) => { useState(0); return <button ref={r} /> })",
    )
    const call = extractWrapperCall(root)
    expect(call?.callee).toBe("forwardRef")
    expect(call?.leaf).toBe("forwardRef")
  })

  it("keeps the callee text verbatim for member-expression callees", async () => {
    const root = await parseRoot("const Btn = React.forwardRef((p, r) => null)")
    const call = extractWrapperCall(root)
    expect(call?.callee).toBe("React.forwardRef")
    expect(call?.leaf).toBe("forwardRef")
  })
})

describe("isContextCall / isForwardRefCall / isMemoCall", () => {
  it("recognizes createContext and React.createContext as context calls", async () => {
    for (const source of ["const C = createContext(null)", "const C = React.createContext(null)"]) {
      const root = await parseRoot(source)
      expect(isContextCall(extractWrapperCall(root))).toBe(true)
    }
  })

  it("recognizes forwardRef and React.forwardRef as forwardRef calls", async () => {
    for (const source of [
      "const Btn = forwardRef((p, r) => null)",
      "const Btn = React.forwardRef((p, r) => null)",
    ]) {
      const root = await parseRoot(source)
      expect(isForwardRefCall(extractWrapperCall(root))).toBe(true)
    }
  })

  it("recognizes memo and React.memo as memo calls", async () => {
    for (const source of ["const M = memo(Inner)", "const M = React.memo(Inner)"]) {
      const root = await parseRoot(source)
      expect(isMemoCall(extractWrapperCall(root))).toBe(true)
    }
  })

  it("does not cross-classify unrelated calls", async () => {
    const root = await parseRoot("const V = someOtherFactory()")
    const call = extractWrapperCall(root)
    expect(isContextCall(call)).toBe(false)
    expect(isForwardRefCall(call)).toBe(false)
    expect(isMemoCall(call)).toBe(false)
  })

  it("returns false when the input is null", () => {
    expect(isContextCall(null)).toBe(false)
    expect(isForwardRefCall(null)).toBe(false)
    expect(isMemoCall(null)).toBe(false)
  })
})
