import { drizzleEffectsPlugin } from "@aburi/effects-drizzle"
import { nestEffectsPlugin } from "@aburi/effects-nest"
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { trpcEffectsPlugin } from "@aburi/effects-trpc"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"

const workspace = useScratchWorkspace("unmodelled-receiver")

describe("scan — a call on an array literal, with every effect plugin loaded", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/names.ts",
      [
        `export function sortedNames(names: string[]) {`,
        `  return [...names].sort()`,
        `}`,
        ``,
        `export function greet(name: string) {`,
        `  return "Hello, " + name`,
        `}`,
        ``,
      ].join("\n"),
    )
  })

  it("keeps the file's Symbols and records the call on `<computed>`", async () => {
    const result = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      effects: [prismaEffectsPlugin, drizzleEffectsPlugin, nestEffectsPlugin, trpcEffectsPlugin],
    })
    expect(result.skipped).toEqual([])
    expect(symbolNamed(result, "greet").source.file).toBe("src/names.ts")
    expect(symbolNamed(result, "sortedNames").calls.map((call) => call.target)).toEqual([
      "<computed>.sort",
    ])
  })
})
