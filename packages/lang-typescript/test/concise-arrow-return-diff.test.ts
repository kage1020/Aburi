import { diffIRs } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanTypeScript } from "./fixtures/scan"

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
    const baseIR = (await scanTypeScript(workspace.root)).ir
    await workspace.writeSource("src/perm.ts", perm("guest"))
    const headIR = (await scanTypeScript(workspace.root)).ir
    const diff = diffIRs(baseIR, headIR)

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
