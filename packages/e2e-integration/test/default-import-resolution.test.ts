import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * A default import binds the module's default export, whatever local name the importer gives
 * it (call-resolution.md §4.4, CR5). Read as a named import of that local name, `connect()`
 * linked to the module's named `connect` and the two calls below reached nothing.
 */

const workspace = useScratchWorkspace("default-import-resolution")

describe("scan — calls through a default import", () => {
  it("resolve to the default export, not to a named export of the same name", async () => {
    await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
    await workspace.writeSource(
      "src/client.ts",
      "export default function createClient() { return 1 }\nexport function connect() { return 2 }\n",
    )
    await workspace.writeSource("src/anon.ts", "export default (x: number) => x + 1\n")
    await workspace.writeSource("src/named.ts", "export default function makeApp() { return 3 }\n")
    await workspace.writeSource(
      "src/use.ts",
      [
        'import connect from "./client"',
        'import inc from "./anon"',
        'import createApp from "./named"',
        "",
        "export function main() {",
        "  connect()",
        "  inc(1)",
        "  createApp()",
        "}",
        "",
      ].join("\n"),
    )

    const { ir } = await scanWith(workspace.root, { languages: [langTypescriptPlugin] })
    const main = ir.symbols.find((s) => s.id === "ts:src/use.ts#main")
    expect(main?.calls.map((c) => [c.target, c.resolved])).toEqual([
      ["connect", "ts:src/client.ts#createClient"],
      ["inc", "ts:src/anon.ts#<default>"],
      ["createApp", "ts:src/named.ts#makeApp"],
    ])
  })
})
