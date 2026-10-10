import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

const workspace = useScratchWorkspace("default-import-resolution")
const MAIN = "ts:src/use.ts#main"

async function callsFromMain(
  modules: Record<string, string>,
  imports: readonly string[],
  calls: readonly string[],
) {
  await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
  for (const [path, source] of Object.entries(modules)) await workspace.writeSource(path, source)
  const body = calls.map((call) => `  ${call}`)
  const use = [...imports, "", "export function main() {", ...body, "}", ""].join("\n")
  await workspace.writeSource("src/use.ts", use)

  const { ir, unresolvedCalls } = await scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
  })
  const main = ir.symbols.find((s) => s.id === MAIN)
  return {
    resolved: main?.calls.map((c) => [c.target, c.resolved]),
    unresolved: unresolvedCalls.filter((d) => d.symbolId === MAIN).map((d) => [d.target, d.bucket]),
  }
}

describe("scan — calls through a default import", () => {
  it("CR5: reaches an anonymous default export, in either spelling of the import", async () => {
    const result = await callsFromMain(
      { "src/anon.ts": "export default (x: number) => x + 1\n" },
      ['import inc from "./anon"', 'import { default as add } from "./anon"'],
      ["inc(1)", "add(2)"],
    )
    expect(result).toEqual({
      resolved: [
        ["inc", "ts:src/anon.ts#<default>"],
        ["add", "ts:src/anon.ts#<default>"],
      ],
      unresolved: [],
    })
  })

  it("CR5a: reaches a named default export under another name, declared with or apart from its export", async () => {
    const result = await callsFromMain(
      {
        "src/named.ts": "export default function makeApp() { return 3 }\n",
        "src/promoted.ts": "const f = () => 4\nexport default f\n",
      },
      ['import createApp from "./named"', 'import g from "./promoted"'],
      ["createApp()", "g()"],
    )
    expect(result).toEqual({
      resolved: [
        ["createApp", "ts:src/named.ts#makeApp"],
        ["g", "ts:src/promoted.ts#f"],
      ],
      unresolved: [],
    })
  })

  it("CR5b: reaches a static member through a default-imported class", async () => {
    const result = await callsFromMain(
      { "src/svc.ts": "export default class Svc {\n  static run() { return 5 }\n}\n" },
      ['import S from "./svc"'],
      ["S.run()"],
    )
    expect(result).toEqual({ resolved: [["S.run", "ts:src/svc.ts#Svc::run"]], unresolved: [] })
  })

  it("CR5c: never takes the named export that shares the local name", async () => {
    const result = await callsFromMain(
      {
        "src/client.ts":
          "export default function createClient() { return 1 }\nexport function connect() { return 2 }\n",
        "src/plain.ts": "export function open() { return 3 }\n",
      },
      ['import connect from "./client"', 'import open from "./plain"'],
      ["connect()", "open()"],
    )
    expect(result).toEqual({
      resolved: [
        ["connect", "ts:src/client.ts#createClient"],
        ["open", null],
      ],
      unresolved: [["open", "no-match"]],
    })
  })

  it("resolves both bindings of `import Foo, * as Bar`", async () => {
    const result = await callsFromMain(
      {
        "src/mixed.ts":
          "export default function make() { return 1 }\nexport function helper() { return 2 }\n",
      },
      ['import build, * as m from "./mixed"'],
      ["build()", "m.helper()"],
    )
    expect(result).toEqual({
      resolved: [
        ["build", "ts:src/mixed.ts#make"],
        ["m.helper", "ts:src/mixed.ts#helper"],
      ],
      unresolved: [],
    })
  })

  it("leaves the default exports §4.4 does not reach unresolved, as known limits", async () => {
    const result = await callsFromMain(
      {
        "src/clause.ts": "function connect() { return 1 }\nexport { connect as default }\n",
        "src/wrapped.ts":
          "function Page() { return 2 }\nfunction withAuth<T>(c: T): T { return c }\nexport default withAuth(Page)\n",
        "src/anon-class.ts": "export default class {\n  static run() { return 3 }\n}\n",
        "src/impl.ts": "export default function impl() { return 4 }\n",
        "src/barrel.ts": 'export { default } from "./impl"\n',
        "src/renamed-barrel.ts": 'export { default as impl } from "./impl"\n',
      },
      [
        'import connect from "./clause"',
        'import Page from "./wrapped"',
        'import Anon from "./anon-class"',
        'import viaBarrel from "./barrel"',
        'import { impl } from "./renamed-barrel"',
      ],
      ["connect()", "Page()", "Anon.run()", "viaBarrel()", "impl()"],
    )
    expect(result).toEqual({
      resolved: [
        ["connect", null],
        ["Page", null],
        ["Anon.run", null],
        ["viaBarrel", null],
        ["impl", null],
      ],
      unresolved: [
        ["connect", "no-match"],
        ["Page", "no-match"],
        ["Anon.run", "no-match"],
        ["viaBarrel", "no-match"],
        ["impl", "no-match"],
      ],
    })
  })
})
