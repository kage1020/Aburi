import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import {
  changedSymbols,
  diffOfEdit,
  pairingOutcome,
  scanTypeScript,
  scanWithoutWarnings,
} from "./fixtures/scan"

const workspace = useScratchWorkspace("module-scope")

const seed = (...statements: string[]) =>
  [
    'import { reset } from "./db"',
    "",
    "export function main() { reset() }",
    "",
    ...statements,
    "",
  ].join("\n")

describe("scan — a module's top-level statements", () => {
  it("resolve the module scope's calls, and no importer calls the module scope", async () => {
    await workspace.writeSource("src/db.ts", "export function reset() {}\n")
    await workspace.writeSource("src/seed.ts", seed("await main()"))
    await workspace.writeSource(
      "src/app.ts",
      'import "./seed"\nimport { main } from "./seed"\nexport function start() { main() }\n',
    )

    const ir = await scanWithoutWarnings(workspace.root)

    expect(ir.symbols.map((s) => s.id).filter((id) => id.endsWith("#<module>"))).toEqual([
      "ts:src/seed.ts#<module>",
    ])
    const scope = ir.symbols.find((s) => s.id === "ts:src/seed.ts#<module>")
    expect(scope?.calls.map((c) => [c.target, c.resolved])).toEqual([
      ["main", "ts:src/seed.ts#main"],
    ])
    const callers = ir.symbols.filter((s) => s.calls.some((c) => c.resolved === scope?.id))
    expect(callers).toEqual([])
  })
})

describe("scan — what a module does on import, when it is ceremony", () => {
  it.each<[string, string[], string[]]>([
    ["kept with its call", [], ["i18n.init"]],
    ["kept without the call a suppression names", ["i18n"], []],
  ])("is %s", async (_label, suppress, calls) => {
    await workspace.writeSource("src/setup.ts", 'i18n.init({ lng: "en" })\n')

    const { ir } = await scanTypeScript(workspace.root, { suppress })

    const scope = ir.symbols.find((s) => s.id === "ts:src/setup.ts#<module>")
    expect(scope?.dropped).toBe(false)
    expect(scope?.calls.map((c) => c.target)).toEqual(calls)
  })
})

describe("diff — a module's top-level statements", () => {
  it("adds `<module>` with the file's first statement and removes it with its last", async () => {
    const added = await diffOfEdit(workspace, "src/seed.ts", seed(), seed("await main()"))
    const removed = await diffOfEdit(workspace, "src/seed.ts", seed("await main()"), seed())

    expect(pairingOutcome(added)).toEqual(["added <module>"])
    expect(pairingOutcome(removed)).toEqual(["removed <module>"])
  })

  it("reports an edit to one of them as a change of `<module>`, and the declarations as they were", async () => {
    const diff = await diffOfEdit(
      workspace,
      "src/seed.ts",
      seed("await main()", "for (const n of [1, 2]) main()"),
      seed("await main()", "for (const n of [1, 2, 3]) main()"),
    )

    expect(changedSymbols(diff).map((c) => [c.name, c.syntaxChanged, c.logicChanged])).toEqual([
      ["<module>", true, false],
    ])
  })
})
