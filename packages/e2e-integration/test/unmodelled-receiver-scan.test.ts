import { drizzleEffectsPlugin } from "@aburi/effects-drizzle"
import { nestEffectsPlugin } from "@aburi/effects-nest"
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { trpcEffectsPlugin } from "@aburi/effects-trpc"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { beforeEach, describe, expect, it } from "vitest"
import { scanWith, symbolNamed } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * A method called on a literal must not cost the file its Symbols.
 *
 * Every effect plugin checks that each `.`-separated segment of a call target is non-empty
 * before its import gate, and throws when one is not — so the check runs in files that never
 * import the plugin's library. A callee the language plugin does not model used to reach the
 * target as its source text, and the `...` of `[...names]` is two empty segments: the throw
 * withdrew the file and every Symbol it declared, `greet` included.
 */

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
