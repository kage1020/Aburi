import { useScratchWorkspace } from "@aburi/test-support"
import type { SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffOfEdit } from "./fixtures/scan"

const workspace = useScratchWorkspace("edit-below-inserted-lines")

const FILE = "src/a.ts"

/** `handle` below `above` declarations, with its guard comparing against `role`. */
const handler = (above: number, role: string) =>
  [
    ...Array.from({ length: above }, (_, i) => `export const setting${i} = ${i}`),
    "export function handle(user: { role: string }): void {",
    `  if (user.role !== "${role}") throw new Error("forbidden")`,
    "  audit(user)",
    "}",
    "",
  ].join("\n")

function handleOf(symbols: readonly SymbolChange[]) {
  const change = symbols.find((c) => "after" in c && c.after.name === "handle")
  if (change === undefined || change.status !== "changed") throw new Error("handle did not change")
  return change
}

describe("an edit to a Symbol that lines inserted above it moved down its file", () => {
  it("is reported as the element it modified, the others staying quiet", async () => {
    const diff = await diffOfEdit(workspace, FILE, handler(0, "admin"), handler(30, "owner"))
    const { delta, after } = handleOf(diff.symbols)
    expect(after.source.startLine).toBe(31)
    expect(delta.rules?.added).toEqual([])
    expect(delta.rules?.removed).toEqual([])
    expect(delta.rules?.modified).toMatchObject([{ type: "guard", line: 32 }])
    expect(delta.calls ?? { added: [], removed: [], modified: [] }).toEqual({
      added: [],
      removed: [],
      modified: [],
    })
  })
})
