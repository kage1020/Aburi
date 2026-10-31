import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanTypeScript } from "./fixtures/scan"

const workspace = useScratchWorkspace("call-resolution")

/** Write `modules` and a `main` in `file` that imports and calls into them, and scan. */
async function callsFromMain(
  modules: Record<string, string>,
  imports: readonly string[],
  calls: readonly string[],
  file = "src/use.ts",
) {
  for (const [path, source] of Object.entries(modules)) await workspace.writeSource(path, source)
  const body = calls.map((call) => `  ${call}`)
  const use = [...imports, "", "export function main() {", ...body, "}", ""].join("\n")
  await workspace.writeSource(file, use)

  const { ir, unresolvedCalls } = await scanTypeScript(workspace.root)
  const mainId = `ts:${file}#main`
  const main = ir.symbols.find((s) => s.id === mainId)
  return {
    resolved: main?.calls.map((c) => [c.target, c.resolved]),
    unresolved: unresolvedCalls
      .filter((d) => d.symbolId === mainId)
      .map((d) => [d.target, d.bucket]),
  }
}

describe("scan — calls through a default import", () => {
  it("reaches an anonymous default export, in either spelling of the import", async () => {
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

  it("reaches a named default export under another name, declared with, apart from or by a clause", async () => {
    const result = await callsFromMain(
      {
        "src/named.ts": "export default function makeApp() { return 3 }\n",
        "src/promoted.ts": "const f = () => 4\nexport default f\n",
        "src/clause.ts": "function connect() { return 1 }\nexport { connect as default }\n",
      },
      [
        'import createApp from "./named"',
        'import g from "./promoted"',
        'import open from "./clause"',
      ],
      ["createApp()", "g()", "open()"],
    )
    expect(result).toEqual({
      resolved: [
        ["createApp", "ts:src/named.ts#makeApp"],
        ["g", "ts:src/promoted.ts#f"],
        ["open", "ts:src/clause.ts#connect"],
      ],
      unresolved: [],
    })
  })

  it("reaches a default export written as a call handed a function", async () => {
    const result = await callsFromMain(
      { "src/handler.ts": "export default withAuth(async (req: unknown) => {\n  save(req)\n})\n" },
      ['import handler from "./handler"'],
      ["handler({})"],
    )
    expect(result).toEqual({
      resolved: [["handler", "ts:src/handler.ts#<default>"]],
      unresolved: [],
    })
  })

  it("reaches a static member through a default-imported class", async () => {
    const result = await callsFromMain(
      { "src/svc.ts": "export default class Svc {\n  static run() { return 5 }\n}\n" },
      ['import S from "./svc"'],
      ["S.run()"],
    )
    expect(result).toEqual({ resolved: [["S.run", "ts:src/svc.ts#Svc::run"]], unresolved: [] })
  })

  it("never takes the named export that shares the local name", async () => {
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

  it("leaves the default exports import scope does not reach unresolved, as known limits, over a namesake", async () => {
    const result = await callsFromMain(
      {
        "src/wrapped.ts":
          "function Page() { return 2 }\nfunction withAuth<T>(c: T): T { return c }\nexport default withAuth(Page)\n",
        "src/anon-class.ts": "export default class {\n  static run() { return 3 }\n}\n",
        "src/namesake.ts": "export class Anon {\n  run() { return 5 }\n}\n",
        "src/impl.ts": "export default function impl() { return 4 }\n",
        "src/barrel.ts": 'export { default } from "./impl"\n',
        "src/renamed-barrel.ts": 'export { default as impl } from "./impl"\n',
      },
      [
        'import Page from "./wrapped"',
        'import Anon from "./anon-class"',
        'import viaBarrel from "./barrel"',
        'import { impl } from "./renamed-barrel"',
      ],
      ["Page()", "Anon.run()", "viaBarrel()", "impl()"],
    )
    const targets = ["Page", "Anon.run", "viaBarrel", "impl"]
    expect(result).toEqual({
      resolved: targets.map((target) => [target, null]),
      unresolved: targets.map((target) => [target, "no-match"]),
    })
  })
})

describe("scan — a call through the name of a class a namespace merged into", () => {
  it("reaches the namespace's export, the member TypeScript calls", async () => {
    await workspace.writeSource(
      "src/c.ts",
      [
        "export class C {",
        "  m(n: number) {",
        "    return n",
        "  }",
        "}",
        "export namespace C {",
        "  export function m(n: number) {",
        "    return helper(n)",
        "  }",
        "}",
        "export function f() {",
        "  return C.m(1)",
        "}",
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/g.ts",
      ["import { C } from './c'", "export function g() {", "  return C.m(2)", "}", ""].join("\n"),
    )

    const result = await scanTypeScript(workspace.root)
    const resolved = (id: string) =>
      result.ir.symbols.find((symbol) => symbol.id === id)?.calls.map((call) => call.resolved)

    expect(resolved("ts:src/c.ts#f")).toEqual(["ts:src/c.ts#C::m"])
    expect(resolved("ts:src/g.ts#g")).toEqual(["ts:src/c.ts#C::m"])
  })
})

describe("scan — a call through the name of a class that lacks the member", () => {
  const MODULES = {
    "src/audit-log.ts":
      "export class Logger {\n  log(message: string) {\n    return message\n  }\n}\n",
    "src/base-logger.ts": "export class Logger {}\n",
    "src/barrel.ts":
      'export { Logger } from "./audit-log"\nexport function other() {\n  return 1\n}\n',
  }

  it.each([
    ["a class the caller's file declares", "class Logger {}"],
    ["a class of fields the caller's file declares, dropped", "class Logger {\n  level = 1\n}"],
    ["a named import of a class its module declares", 'import { Logger } from "./base-logger"'],
  ])("stops at %s, bucketed `no-match`", async (_label, head) => {
    expect(await callsFromMain(MODULES, [head], ['Logger.log("x")'])).toEqual({
      resolved: [["Logger.log", null]],
      unresolved: [["Logger.log", "no-match"]],
    })
  })

  it.each([
    ["a barrel that re-exports it", "src/use.ts", 'import { Logger } from "./barrel"'],
    ["a workspace package", "src/use.ts", 'import { Logger } from "@acme/logging"'],
    ["a `require` in JavaScript", "src/use.js", 'const { Logger } = require("./audit-log")'],
    ["an ambient declaration", "src/use.ts", "declare const Logger: { log(m: string): string }"],
  ])("searches on past %s to the class that declares the member", async (_label, file, head) => {
    expect(await callsFromMain(MODULES, [head], ['Logger.log("x")'], file)).toEqual({
      resolved: [["Logger.log", "ts:src/audit-log.ts#Logger.log"]],
      unresolved: [],
    })
  })
})

describe("scan — a call through the name of a dropped class", () => {
  it("reaches a member a namespace merged into the class keeps", async () => {
    const head = [
      "class Config {",
      "  static readonly A = 1",
      "}",
      "namespace Config {",
      "  export function load() {",
      "    return 2",
      "  }",
      "}",
    ]
    expect(await callsFromMain({}, head, ["Config.load()"])).toEqual({
      resolved: [["Config.load", "ts:src/use.ts#Config::load"]],
      unresolved: [],
    })
  })
})
