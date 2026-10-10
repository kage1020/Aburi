import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanTypeScript } from "./fixtures/scan"

const workspace = useScratchWorkspace("names")

async function scanSources(files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await workspace.writeSource(name, content)
  }
  const result = await scanTypeScript(workspace.root)
  return { ids: result.ir.symbols.map((symbol) => symbol.id), skipped: result.skipped }
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
    [
      "a quoted member name",
      'export class A {\n  "ok"() {}\n  m() {}\n}\n',
      ["ts:bad.ts#A", "ts:bad.ts#A.m", "ts:bad.ts#A.ok"],
    ],
    [
      "a member name that is not an identifier once decoded",
      'export class A {\n  "a-b"() {}\n  1() {}\n  m() {}\n}\n',
      ["ts:bad.ts#A", "ts:bad.ts#A.m"],
    ],
  ])("scans %s without losing the file", async (_label, source, expected) => {
    const { ids, skipped } = await scanSources({ "bad.ts": source })

    expect(skipped).toEqual([])
    expect(ids).toEqual(expected)
  })

  it("no longer costs an unrelated file its place in the run", async () => {
    const { ids, skipped } = await scanSources({
      "bad.ts": "export const { GET, POST } = handlers\n",
      "ok.ts": "export function ok() {}\n",
    })

    expect(skipped).toEqual([])
    expect(ids).toEqual(["ts:bad.ts#GET", "ts:bad.ts#POST", "ts:ok.ts#ok"])
  })
})
