import { diffIRs, scanWith } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import type { IR, Symbol as IRSymbol, SymbolChanged } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { langTypescriptPlugin } from "../src/index"

const workspace = useScratchWorkspace("parameter-form")

async function scanOf(source: string): Promise<IR> {
  await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
  await workspace.writeSource("src/users.ts", source)
  const { ir } = await scanWith(workspace.root, { languages: [langTypescriptPlugin] })
  return ir
}

function f(ir: IR): IRSymbol {
  const found = ir.symbols.find((s) => s.name === "f")
  if (found === undefined) throw new Error("the scan read no Symbol f")
  return found
}

/** `f` with this parameter list and a body that stays the same, so only the list differs. */
function withParams(params: string): string {
  return `function use(): void {}\n\nexport function f(${params}): void {\n  use()\n}\n`
}

/** The one Symbol the diff reports `changed`, or null when it reports none. */
function changeOf(base: IR, head: IR): SymbolChanged | null {
  const change = diffIRs(base, head).symbols.find((s) => s.status === "changed")
  return change?.status === "changed" ? change : null
}

describe("diff — a parameter's form", () => {
  it.each([
    ["optional to required", "query?: string", "query: string"],
    ["an array to a rest parameter", "tags: string[]", "...tags: string[]"],
    ["a default dropped", "limit: number = 10", "limit: number"],
  ])("reports %s as an api change", async (_label, before, after) => {
    const baseIR = await scanOf(withParams(before))
    const headIR = await scanOf(withParams(after))

    expect(diffIRs(baseIR, headIR).summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
    const change = changeOf(baseIR, headIR)
    expect(change?.after.name).toBe("f")
    expect(change?.delta).toMatchObject({ apiChanged: true, logicChanged: false })
    expect(change?.delta.signature?.inputs.modified).toEqual(f(headIR).signature?.inputs)
  })

  it("does not report a changed default value as an api change", async () => {
    const beforeIR = await scanOf("export function f(limit = 10): void {}\n")
    const afterIR = await scanOf("export function f(limit = 20): void {}\n")
    expect(f(afterIR).signature?.inputs).toEqual([{ name: "limit", type: "", optional: true }])
    expect(f(afterIR).fingerprint.api).toBe(f(beforeIR).fingerprint.api)
    expect(changeOf(beforeIR, afterIR)).toBeNull()
  })
})

describe("scan — a rest parameter's name", () => {
  it("shadows a module-level Symbol of the same name, as any parameter does", async () => {
    const ir = await scanOf(
      "export function save(): void {}\n\nexport function run(...save: Array<() => void>): void {\n  save()\n}\n",
    )
    const run = ir.symbols.find((s) => s.name === "run")
    expect(run?.signature?.inputs).toEqual([
      { name: "save", type: "Array<() => void>", rest: true },
    ])
    expect(run?.calls.map((c) => c.resolved)).toEqual([null])
    expect(ir.dependencies.filter((d) => d.from === run?.id)).toEqual([])
  })
})
