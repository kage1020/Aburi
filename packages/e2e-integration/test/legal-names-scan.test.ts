import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { scanFixture } from "../src/scan-helper"

/**
 * A destructuring declaration, a non-ASCII identifier and a computed member name each fed
 * something that is not a name into the Symbol-id builder, which threw — and the throw was
 * caught at the per-file boundary, so the file was skipped as `extraction-failed` and every
 * Symbol in it went too.
 *
 * The unit tests pin what extraction now produces. What these pin is the half only a scan can
 * see: the file reaches the IR at all, and `skipped` is empty.
 */

async function scanSources(files: Record<string, string>) {
  const root = await mkdtemp(resolve(tmpdir(), "aburi-names-"))
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(resolve(root, name), content, "utf8")
    }
    const result = await scanFixture(root)
    return { ids: result.ir.symbols.map((s) => s.id), skipped: result.skipped }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("a file that names things legally keeps its Symbols", () => {
  it.each([
    [
      "a destructured export",
      "export const { GET, POST } = handlers\nexport function also() {}\n",
      ["ts:bad.ts#GET", "ts:bad.ts#POST", "ts:bad.ts#also"],
    ],
    [
      "an array destructure",
      "export const [first, second] = pair\n",
      ["ts:bad.ts#first", "ts:bad.ts#second"],
    ],
    [
      "a non-ASCII identifier",
      "export function ユーザー取得() {}\nexport function also() {}\n",
      ["ts:bad.ts#also", "ts:bad.ts#ユーザー取得"],
    ],
    ["an accented identifier", "export function café() {}\n", ["ts:bad.ts#café"]],
    [
      "a computed member name",
      "export class A {\n  [Symbol.iterator]() {}\n  m() {}\n}\n",
      ["ts:bad.ts#A", "ts:bad.ts#A.m"],
    ],
  ])("scans %s without losing the file", async (_label, source, expected) => {
    const { ids, skipped } = await scanSources({ "bad.ts": source })

    expect(skipped).toEqual([])
    expect(ids).toEqual(expected)
  })

  it("no longer costs an unrelated file its place in the run", async () => {
    // The state this replaces: `bad.ts` skipped as `extraction-failed`, `ok.ts` the only
    // Symbol in the IR, and the run exiting non-zero under a field that means a plugin bug.
    const { ids, skipped } = await scanSources({
      "bad.ts": "export const { GET, POST } = handlers\n",
      "ok.ts": "export function ok() {}\n",
    })

    expect(skipped).toEqual([])
    expect(ids).toEqual(["ts:bad.ts#GET", "ts:bad.ts#POST", "ts:ok.ts#ok"])
  })
})
