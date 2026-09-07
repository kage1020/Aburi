import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { buildDiff } from "@aburi/diff"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scanFixture } from "../src/scan-helper"

/**
 * A parenthesis-free arrow — `x => x + 1` — states its parameter without a parameter
 * list, and the signature reader used to find none. Two edits fall out of that reading,
 * and neither is what the source did:
 *
 *   - Dropping the parameter (`name => "hi"` → `() => "hi"`) changed nothing the diff
 *     could see. Both revisions read zero-arity, the body is untouched, and a caller
 *     passing an argument was told nothing.
 *   - Adding parentheses around it (`x => …` → `(x) => …`) changed the api. One
 *     function written two ways became a signature change with no callee to fix.
 *
 * This runs the real pipeline over both edits: scan, mutate on disk, scan again, diff.
 */

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-bare-arrow-arity-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

async function writeSource(rel: string, content: string): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

/** Scan `before`, rewrite the one source file to `after`, scan again, diff the two. */
async function diffOfEdit(before: string, after: string): Promise<ReturnType<typeof buildDiff>> {
  await writeSource("src/greet.ts", before)
  const baseIR = (await scanFixture(workRoot)).ir
  await writeSource("src/greet.ts", after)
  const headIR = (await scanFixture(workRoot)).ir

  const irSchema = "https://aburi.kage1020.com/schema/aburi.ir.v1.json"
  return buildDiff({
    baseIR,
    headIR,
    base: { ref: "base", irSchema },
    head: { ref: "head", irSchema },
  })
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
