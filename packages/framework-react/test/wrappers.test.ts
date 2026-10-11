import { describe, expect, it } from "vitest"
import { extractWrapperCall, isContextCall, isForwardRefCall, isMemoCall } from "../src/index"
import { candidateNamed } from "./fixtures/symbol"

async function wrapperOf(declaration: string) {
  return extractWrapperCall((await candidateNamed(`export ${declaration}`, "X")).fullNode)
}

describe("extractWrapperCall", () => {
  it("finds the outer wrapping call, not one inside its argument", async () => {
    expect(
      await wrapperOf("const X = forwardRef((p, r) => { useState(0); return <button ref={r} /> })"),
    ).toEqual({ callee: "forwardRef", leaf: "forwardRef" })
  })

  it("keeps a member callee verbatim beside its leaf", async () => {
    expect(await wrapperOf("const X = React.forwardRef((p, r) => null)")).toEqual({
      callee: "React.forwardRef",
      leaf: "forwardRef",
    })
  })

  it("returns null for a const no call initializes", async () => {
    expect(await wrapperOf("const X = 42")).toBeNull()
  })

  it.each([
    null,
    { placeholder: true },
  ])("returns null for %o, which is not a syntax node", (node) => {
    expect(extractWrapperCall(node)).toBeNull()
  })
})

describe("isContextCall / isForwardRefCall / isMemoCall", () => {
  it.each([
    ["const X = createContext(null)", [true, false, false]],
    ["const X = React.createContext(null)", [true, false, false]],
    ["const X = forwardRef((p, r) => null)", [false, true, false]],
    ["const X = React.forwardRef((p, r) => null)", [false, true, false]],
    ["const X = memo(Inner)", [false, false, true]],
    ["const X = React.memo(Inner)", [false, false, true]],
    ["const X = someOtherFactory()", [false, false, false]],
  ])("reads `%s` as [context, forwardRef, memo] = %j", async (declaration, expected) => {
    const call = await wrapperOf(declaration)
    expect([isContextCall(call), isForwardRefCall(call), isMemoCall(call)]).toEqual(expected)
  })

  it("returns false for no call at all", () => {
    expect([isContextCall(null), isForwardRefCall(null), isMemoCall(null)]).toEqual([
      false,
      false,
      false,
    ])
  })
})
