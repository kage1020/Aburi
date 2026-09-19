import { describe, expect, it } from "vitest"
import { diffIRs, scanFixture } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * A parenthesis-free arrow — `x => x + 1` — states its parameter without a parameter
 * list, and the signature reader used to find none. Two edits fell out of that reading,
 * and neither is what the source did:
 *
 *   - Dropping the parameter (`name => "hi"` → `() => "hi"`) changed nothing the diff
 *     could see: both revisions read zero-arity.
 *   - Adding parentheses around it (`x => …` → `(x) => …`) changed the api: one function
 *     written two ways became a signature change with no callee to fix.
 *
 * This runs the real pipeline over both edits: scan, mutate on disk, scan again, diff.
 */

const workspace = useScratchWorkspace("bare-arrow-arity")

/** Scan `before`, rewrite the one source file to `after`, scan again, diff the two. */
async function diffOfEdit(before: string, after: string): Promise<ReturnType<typeof diffIRs>> {
  await workspace.writeSource("src/greet.ts", before)
  const baseIR = (await scanFixture(workspace.root)).ir
  await workspace.writeSource("src/greet.ts", after)
  const headIR = (await scanFixture(workspace.root)).ir
  return diffIRs(baseIR, headIR)
}

describe("e2e diff — a parenthesis-free arrow's parameter", () => {
  it("reports the removed parameter as an api change", async () => {
    const diff = await diffOfEdit(
      'export const greet = name => "hi"\n',
      'export const greet = () => "hi"\n',
    )

    expect(diff.summary.changed).toBe(1)
    expect(diff.summary.added).toBe(0)
    expect(diff.summary.removed).toBe(0)

    const [change] = diff.symbols.filter((c) => c.status === "changed")
    if (change?.status !== "changed") throw new Error("greet reported no change")
    expect(change.after.name).toBe("greet")
    expect(change.delta.apiChanged).toBe(true)
    expect(change.delta.signature?.inputs.removed).toEqual([{ name: "name", type: "" }])
  })

  it("reports no change when the same parameter gains parentheses", async () => {
    const diff = await diffOfEdit(
      'export const greet = name => "hi"\n',
      'export const greet = (name) => "hi"\n',
    )

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 0, moved: 0 })
    // `symbols` carries only what changed, so an unchanged function leaves it empty.
    expect(diff.symbols).toEqual([])
  })
})
