import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { projectDiff } from "@aburi/markdown-projection"
import { diffIRs, type PluginLineup, scanWith } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"

const lineup: PluginLineup = {
  languages: [langTypescriptPlugin],
  effects: [prismaEffectsPlugin],
}

const QUEUE_BASE = `export function drain(queue: string[]): number {
  let n = 0
  for (const item of queue) {
    n += item.length
  }
  return n
}
`

const QUEUE_HEAD = `export function drain(queue: string[]): number {
  let n = 0
  while (queue.length > 0) {
    n += queue.pop()!.length
  }
  return n
}
`

const USERS_BASE = `import { PrismaClient } from "@prisma/client"
const prisma = new PrismaClient()
export async function createUser(data: { name: string }, audit: boolean) {
  if (!data.name) throw new Error("name required")
  return prisma.user.create({ data })
}
`

// One argument more than `create` takes is what lowers effects-prisma's confidence.
const USERS_HEAD = `import { PrismaClient } from "@prisma/client"
const prisma = new PrismaClient()
export async function createUser(data: { name: string }, audit: boolean) {
  if (!data.name || data.name.length > 64) throw new Error("name required")
  return prisma.user.create({ data }, audit)
}
`

const workspace = useScratchWorkspace("modified-row-fields")

describe("e2e diff → Markdown — a modified loop and a downgraded effect", () => {
  it("sets the base loop kind, condition and confidence beside the head ones", async () => {
    await workspace.writeSource("src/queue.ts", QUEUE_BASE)
    await workspace.writeSource("src/users.ts", USERS_BASE)
    const base = await scanWith(workspace.root, lineup)
    await workspace.writeSource("src/queue.ts", QUEUE_HEAD)
    await workspace.writeSource("src/users.ts", USERS_HEAD)
    const head = await scanWith(workspace.root, lineup)

    const md = projectDiff(diffIRs(base.ir, head.ir))

    expect(md).toContain(
      "### `drain` *(function)*\n**File**: `src/queue.ts:1`\n\n- rules modified:\n  - loop (`for` → `while`) (L3)\n",
    )
    expect(md).toContain(
      [
        "- rules modified:",
        "  - guard: `!data.name` → `!data.name || data.name.length > 64` (L4)",
        "- effects modified:",
        "  - db.write: `prisma.user.create` (L5) [effects-prisma] ⚠ medium (was high)",
      ].join("\n"),
    )
  })
})
