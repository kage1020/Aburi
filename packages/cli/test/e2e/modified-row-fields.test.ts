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

const GUARDS_BASE = `export function check(a: number, b: number): void {
  if (a < 0) throw new RangeError("a")
  if (b < 0) throw new RangeError("b")
}
`

const GUARDS_HEAD = `export function check(a: number, b: number): void {
  if (a <= 0) throw new RangeError("a")
  if (b < 0) throw new RangeError("b")
}
`

const LOOPS_BASE = `export function run(items: string[]): number {
  let n = 0
  for (const item of items) n += item.length
  do {
    n -= 1
  } while (n > 100)
  return n
}
`

const LOOPS_HEAD = `export function run(items: string[]): number {
  let n = 0
  while (items.length > 0) n += items.pop()!.length
  return n
}
`

const SOURCES = [
  ["src/queue.ts", { base: QUEUE_BASE, head: QUEUE_HEAD }],
  ["src/users.ts", { base: USERS_BASE, head: USERS_HEAD }],
  ["src/guards.ts", { base: GUARDS_BASE, head: GUARDS_HEAD }],
  ["src/loops.ts", { base: LOOPS_BASE, head: LOOPS_HEAD }],
] as const

const workspace = useScratchWorkspace("modified-row-fields")

describe("e2e diff → Markdown — modified rows beside the base values the diff paired them with", () => {
  it("sets the base loop kind, condition and confidence beside the head ones", async () => {
    for (const [file, source] of SOURCES) await workspace.writeSource(file, source.base)
    const base = await scanWith(workspace.root, lineup)
    for (const [file, source] of SOURCES) await workspace.writeSource(file, source.head)
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
    expect(md).toContain("- rules modified:\n  - guard: `a < 0` → `a <= 0` (L2)\n")
    expect(md).toContain(
      "- rules removed:\n  - loop (`do`) (L4)\n- rules modified:\n  - loop (`for` → `while`) (L3)\n",
    )
  })
})
