import { describe, expect, it } from "vitest"
import { diffIRs, scanFixture } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * One predicate written twice, once as a concise arrow and once with a block body. The arrow's
 * expression is its return value, and used to earn no `return` rule, so editing it moved no
 * `logic` fingerprint: the block twin was a logic change and the arrow a syntax-only one, and
 * `--fail-on logic-changed` saw half the edit. This runs the real pipeline: scan, edit on disk,
 * scan again, diff.
 */

const workspace = useScratchWorkspace("concise-arrow-return")

const perm = (role: string) =>
  [
    "interface User { role: string }",
    "",
    `export const canEdit = (u: User) => u.role === "${role}"`,
    "",
    "export function canEditBlock(u: User) {",
    `  return u.role === "${role}"`,
    "}",
    "",
  ].join("\n")

describe("e2e diff — an edit to a concise arrow's returned expression", () => {
  it("reports both spellings as logic changes", async () => {
    await workspace.writeSource("src/perm.ts", perm("admin"))
    const baseIR = (await scanFixture(workspace.root)).ir
    await workspace.writeSource("src/perm.ts", perm("guest"))
    const headIR = (await scanFixture(workspace.root)).ir
    const diff = diffIRs(baseIR, headIR)

    // Not the guard: the literal is part of the syntax fingerprint, so `canEdit` was reported as
    // changed before its body earned a rule too. `logicChanged: true` on it is what goes red when
    // the arrow's body is read as a bare expression again.
    expect(diff.summary.changed).toBe(2)
    const changed = diff.symbols.flatMap((c) =>
      c.status === "changed" ? [{ name: c.after.name, logicChanged: c.delta.logicChanged }] : [],
    )
    expect(changed.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "canEdit", logicChanged: true },
      { name: "canEditBlock", logicChanged: true },
    ])
  })
})
