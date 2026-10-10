import { langTypescriptPlugin } from "@aburi/lang-typescript"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffIRs, scanWith, warningCollector } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

const workspace = useScratchWorkspace("overload-edit")

async function scanSilently(): Promise<IR> {
  const { logger, warnings } = warningCollector()
  const { ir } = await scanWith(
    workspace.root,
    { languages: [langTypescriptPlugin] },
    {},
    { logger },
  )
  expect(warnings).toEqual([])
  return ir
}

/** Scan `before`, rewrite the one source file to `after`, scan again, diff the two. */
async function diffOfEdit(before: string, after: string): Promise<ReturnType<typeof diffIRs>> {
  await workspace.writeSource("src/config.ts", before)
  const baseIR = await scanSilently()
  await workspace.writeSource("src/config.ts", after)
  const headIR = await scanSilently()
  return diffIRs(baseIR, headIR)
}

/** Only the syntax axis moved: the api axis reads the implementation's one signature. */
const SYNTAX_ONLY = {
  apiChanged: false,
  logicChanged: false,
  syntaxChanged: true,
  visibilityChanged: false,
  componentChanged: false,
}

/** The names of the Symbols the diff reports `changed`, each with its delta. */
function changedOf(diff: ReturnType<typeof diffIRs>) {
  return diff.symbols.flatMap((c) =>
    c.status === "changed" ? [{ name: c.after.name, ...c.delta }] : [],
  )
}

const parser = (overload: string) =>
  [
    "export interface Config { name: string }",
    "",
    "export function parse(input: string): Config;",
    `export function parse(input: ${overload}): Config;`,
    "export function parse(input: any): any {",
    "  return decode(input)",
    "}",
    "",
  ].join("\n")

const repository = (...overloads: string[]) =>
  [
    "export class Repository {",
    ...overloads.map((overload) => `  find(id: ${overload}): User;`),
    "  find(id: any): any {",
    "    return load(id)",
    "  }",
    "}",
    "",
  ].join("\n")

describe("e2e diff — an edit to one overload signature", () => {
  it("reports a module-level function whose overload was retyped", async () => {
    const diff = await diffOfEdit(parser("Buffer"), parser("Uint8Array"))

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
    const changed = changedOf(diff)
    expect(changed.map((c) => c.name)).toEqual(["parse"])
    expect(changed[0]).toMatchObject(SYNTAX_ONLY)
  })

  it("reports the method whose overload was removed, not only its class", async () => {
    const diff = await diffOfEdit(repository("string", "number"), repository("string"))

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 2 })
    const changed = changedOf(diff)
    expect(changed.map((c) => c.name).sort()).toEqual(["Repository", "Repository.find"])
    for (const c of changed) expect(c).toMatchObject(SYNTAX_ONLY)
  })
})
