import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { EXIT, IR_JSON_FILENAME } from "../src"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("gitignore-override")

const KEPT = "ts:src/a.ts#alpha"
const IGNORED = "ts:src/gen.ts#generated"

describe("aburi scan — whether .gitignore is honoured", () => {
  it.each<[string, boolean | undefined, string[], string[]]>([
    ["by default", undefined, [], [KEPT]],
    ["off when the config turns it off", false, [], [KEPT, IGNORED]],
    [
      "off under --no-respect-gitignore, over a config that says true",
      true,
      ["--no-respect-gitignore"],
      [KEPT, IGNORED],
    ],
    [
      "on under --respect-gitignore, over a config that says false",
      false,
      ["--respect-gitignore"],
      [KEPT],
    ],
  ])("is %s", async (_, respectGitignore, flags, symbols) => {
    await writePackageJson(workspace.root)
    await workspace.writeSource(".gitignore", "src/gen.ts\n")
    await workspace.writeSource("src/a.ts", "export function alpha() { return 1 }\n")
    await workspace.writeSource("src/gen.ts", "export function generated() { return 2 }\n")
    await writeConfig(
      workspace.root,
      respectGitignore === undefined ? TYPESCRIPT : { ...TYPESCRIPT, respectGitignore },
    )

    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--format", "json", ...flags])

    expect(code, stderr).toBe(EXIT.SUCCESS)
    const ir = JSON.parse(
      await readFile(resolve(workspace.root, "out", IR_JSON_FILENAME), "utf8"),
    ) as IR
    expect(ir.symbols.map((symbol) => symbol.id).sort()).toEqual([...symbols].sort())
  })
})
