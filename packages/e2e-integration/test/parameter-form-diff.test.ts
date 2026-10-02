import { langTypescriptPlugin } from "@aburi/lang-typescript"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffIRs, scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * Making an optional parameter required, or an array parameter a rest one, breaks callers, so
 * it is an api change. The `?` and the `...` reached no fingerprint and the diff reported no
 * change at all (lang-plugin.md LP11b).
 */

const workspace = useScratchWorkspace("parameter-form")

async function scanOf(source: string): Promise<IR> {
  await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
  await workspace.writeSource("src/users.ts", source)
  const { ir } = await scanWith(workspace.root, { languages: [langTypescriptPlugin] })
  return ir
}

async function apiChangedOf(before: string, after: string): Promise<boolean | null> {
  const diff = diffIRs(await scanOf(before), await scanOf(after))
  const change = diff.symbols.find((s) => s.status === "changed")
  if (change === undefined || change.status !== "changed") return null
  return change.delta.apiChanged
}

describe("diff — a parameter's form", () => {
  it.each([
    ["optional to required", "query?: string", "query: string"],
    ["an array to a rest parameter", "tags: string[]", "...tags: string[]"],
    ["a default dropped", "limit: number = 10", "limit: number"],
  ])("reports %s as an api change", async (_label, before, after) => {
    const fn = (params: string) =>
      `export function f(${params}): void {\n  use(${params.split(/[?:=]/)[0]})\n}\n`
    expect(await apiChangedOf(fn(before), fn(after))).toBe(true)
  })

  it("does not report a changed default value as an api change", async () => {
    const before = "export function f(limit = 10): void {}\n"
    const after = "export function f(limit = 20): void {}\n"
    // Not on the api axis by choice (fingerprint.md §3.4); the value sits in the parameter
    // list, outside the body the syntax axis reads, so no axis moves at all yet.
    expect(await apiChangedOf(before, after)).not.toBe(true)
  })
})
