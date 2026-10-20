import { resolve } from "node:path"
import { commitAll, initRepository, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { DIFF_JSON_FILENAME, EXIT, IR_JSON_FILENAME } from "../src"
import { pathExists } from "../src/fs-probe"
import { EFFECTS_MANIFEST, pluginModuleSource } from "./plugin-fakes"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig } from "./workspace"

const workspace = useScratchWorkspace("plugin-set-faults")

const REFUSE_THROUGH_REGISTRY = `ctx.registry.assertEffectDeclared("x-foo:write", "effects-foo")
    return null`

const REFUSED = 'Effect id "x-foo:write" is not declared by any registered plugin.'

/** A TypeScript workspace making one call, which an effects plugin running `classify` sees. */
async function writeWorkspace(classify: string): Promise<void> {
  await writeConfig(workspace.root, { ...TYPESCRIPT, effects: ["./effects-foo.mjs"] })
  await workspace.writeSource("src/a.ts", "function g() {}\nexport function f() {\n  g()\n}\n")
  await workspace.writeSource(
    "effects-foo.mjs",
    pluginModuleSource(
      { ...EFFECTS_MANIFEST, name: "effects-foo" },
      `  init: async () => {},
  classify: (call, ctx) => {
    ${classify}
  },`,
    ),
  )
}

describe("aburi scan — a fault in the plugin set raised while classifying", () => {
  it.each<[string, string, string[], string]>([
    [
      "a value the plugin refuses through the registry it is handed",
      REFUSE_THROUGH_REGISTRY,
      [],
      REFUSED,
    ],
    [
      "the same refusal under --discover, which the registry does not read",
      REFUSE_THROUGH_REGISTRY,
      ["--discover"],
      REFUSED,
    ],
    [
      "a Promise returned from classify",
      "return Promise.resolve(null)",
      [],
      'Effect plugin "effects-foo" returned a Promise from classify()',
    ],
  ])("exits 3 for %s, with its message, writing nothing", async (_, classify, flags, says) => {
    await writeWorkspace(classify)

    const { code, stdout, stderr } = await runCliIn(workspace.root, [
      "scan",
      "--format",
      "json",
      ...flags,
    ])

    expect(code, stderr).toBe(EXIT.GATE)
    expect(stderr).toContain(says)
    expect(stdout).toBe("")
    expect(await pathExists(resolve(workspace.root, "out", IR_JSON_FILENAME))).toBe(false)
  })

  it("exits 0 for the same plugin classifying the call as nothing", async () => {
    await writeWorkspace("return null")

    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--format", "json"])

    expect(code, stderr).toBe(EXIT.SUCCESS)
    expect(await pathExists(resolve(workspace.root, "out", IR_JSON_FILENAME))).toBe(true)
  })
})

describe("every command that scans — a value refused through a plugin's registry", () => {
  it.each([
    ["aburi explain", ["explain", "f"], IR_JSON_FILENAME],
    ["aburi diff", ["diff", "main..HEAD"], DIFF_JSON_FILENAME],
  ])("%s exits 3, with the refusal's message, writing nothing", async (_, argv, filename) => {
    await writeWorkspace(REFUSE_THROUGH_REGISTRY)
    await initRepository(workspace.root)
    await commitAll(workspace.root)

    const { code, stdout, stderr } = await runCliIn(workspace.root, argv)

    expect(code, stderr).toBe(EXIT.GATE)
    expect(stderr).toContain(REFUSED)
    expect(stdout).toBe("")
    expect(await pathExists(resolve(workspace.root, "out", filename))).toBe(false)
  })
})
