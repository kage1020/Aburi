import { parseTypescriptFile } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { bodyCallsAnotherHook, matchesHookNaming } from "../src/index"

async function parseRoot(source: string): Promise<unknown> {
  const result = await parseTypescriptFile({ path: "src/f.tsx", content: source })
  if (result.tree === null) throw new Error("parse returned null")
  return result.tree.rootNode
}

describe("matchesHookNaming", () => {
  it.each([
    ["useState", true],
    ["useEffect", true],
    ["useMyHook", true],
    ["use", false],
    ["useful", false],
    ["usable", false],
    ["User", false],
    ["State", false],
    ["", false],
  ])("matchesHookNaming(%j) === %j", (leaf, expected) => {
    expect(matchesHookNaming(leaf)).toBe(expected)
  })
})

describe("bodyCallsAnotherHook", () => {
  it("returns false for null (no body)", () => {
    expect(bodyCallsAnotherHook(null)).toBe(false)
  })

  it("returns true when the body calls useState directly", async () => {
    const root = await parseRoot("function useThing() { const [x] = useState(0); return x }")
    expect(bodyCallsAnotherHook(root)).toBe(true)
  })

  it("returns true when the body calls a hook via member expression", async () => {
    // Leaf-only match: React.useEffect counts as a hook-call because the leaf is useEffect.
    const root = await parseRoot("function useX() { React.useEffect(() => {}, []); return null }")
    expect(bodyCallsAnotherHook(root)).toBe(true)
  })

  it("returns false when the body only calls non-hooks", async () => {
    const root = await parseRoot("function useNothing() { return doWork() }")
    expect(bodyCallsAnotherHook(root)).toBe(false)
  })
})
