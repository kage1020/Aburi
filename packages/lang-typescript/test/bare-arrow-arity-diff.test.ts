import { diffIRs } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanTypeScript } from "./fixtures/scan"

const workspace = useScratchWorkspace("bare-arrow-arity")

/** Scan `before`, rewrite the one source file to `after`, scan again, diff the two. */
async function diffOfEdit(before: string, after: string): Promise<ReturnType<typeof diffIRs>> {
  await workspace.writeSource("src/greet.ts", before)
  const baseIR = (await scanTypeScript(workspace.root)).ir
  await workspace.writeSource("src/greet.ts", after)
  const headIR = (await scanTypeScript(workspace.root)).ir
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
