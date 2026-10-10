import { describe, expect, it } from "vitest"
import {
  langTypescriptManifest,
  langTypescriptPlugin,
  TYPESCRIPT_FILE_DROP_PATTERNS,
  TYPESCRIPT_FILE_EXTENSIONS,
} from "../src/index"
import { idsOf, symbolsOf } from "./fixtures/ctx"

describe("langTypescriptPlugin.languageId", () => {
  it("is the prefix the plugin writes onto every Symbol id, not the manifest name", async () => {
    const ids = await idsOf("export function alpha() {}\n")

    expect(langTypescriptPlugin.languageId).toBe("ts")
    expect(langTypescriptPlugin.languageId).not.toBe(langTypescriptPlugin.manifest.name)
    expect(ids).toEqual(["ts:src/a.ts#alpha"])
  })
})

describe("every rationale extraction emits is one the manifest declares", () => {
  /** Whether a manifest prefix owns `token`: the prefix itself, or the prefix and a `:` part. */
  const declares = (token: string) =>
    langTypescriptManifest.provides.derivedByPrefixes.some(
      (prefix) => token === prefix || token.startsWith(`${prefix}:`),
    )

  it.each([
    ["export const { a } = m", ["destructured-binding"]],
    ["export const x = 1", ["export-keyword"]],
    ["export const f = () => 1", ["variable-assigned-function", "export-keyword"]],
    ["export class A { m() {} }", ["export-keyword", "class-method"]],
    ["export class A { static m() {} }", ["static-method"]],
    ["export class A { constructor() {} }", ["constructor-declaration"]],
    ["export class A { f = () => 1 }", ["field-assigned-function"]],
    ["export interface I {}", ["interface-declaration", "export-keyword"]],
    ["export type T = 1", ["type-alias", "export-keyword"]],
    ["export enum E { A }", ["enum-declaration", "export-keyword"]],
    ["export namespace N {}", ["namespace-declaration", "export-keyword"]],
    ["export declare interface I {}", ["interface-declaration", "export-keyword"]],
    ["export default function () {}", ["export-default"]],
    ["export default interface I {}", ["interface-declaration", "export-default"]],
    ["export class A { get v() { return 1 } }", ["accessor-declaration"]],
    [
      "export class A { get v() { return 1 } set v(n) {} }",
      ["accessor-declaration", "declaration-merged"],
    ],
    ["export abstract class A { abstract m(): void }", ["abstract-declaration"]],
    ["export declare function f(): void", ["ambient-declaration"]],
    [
      "export const o = { m() {}, f: () => {} }",
      ["object-literal-initializer", "object-method", "property-assigned-function"],
    ],
    ["export const h = withAuth(() => {})", ["call-argument-function"]],
    [
      'app.route("/x").get(() => {})',
      ["call-statement:app.get", "chained-call", "path-literal:/x", "inline-handler"],
    ],
    ["app.use(logger)", ["call-statement:app.use", "argument-names:logger"]],
  ])("declares the rationales %s produces", async (source, expected) => {
    const emitted = (await symbolsOf(source)).flatMap((s) => s.derivedBy)

    expect(emitted).toEqual(expect.arrayContaining(expected))
    expect(emitted.filter((token) => !declares(token))).toEqual([])
  })
})

describe("the files this plugin claims and drops", () => {
  it("claims every TypeScript and JavaScript module extension", () => {
    expect([...TYPESCRIPT_FILE_EXTENSIONS].sort()).toEqual([
      ".cjs",
      ".cts",
      ".js",
      ".jsx",
      ".mjs",
      ".mts",
      ".ts",
      ".tsx",
    ])
  })

  it("drops a declaration file in each of the three module spellings", () => {
    expect([...TYPESCRIPT_FILE_DROP_PATTERNS].sort()).toEqual([
      "**/*.d.cts",
      "**/*.d.mts",
      "**/*.d.ts",
    ])
  })
})

describe("langTypescriptPlugin.releaseTree", () => {
  it("frees the tree it is given", async () => {
    const { tree } = await langTypescriptPlugin.parseFile({
      path: "src/a.ts",
      content: "export function f() { return 1 }\n",
    })
    if (tree === null) throw new Error("the parse built no tree")
    expect(tree.rootNode.type).toBe("program")

    langTypescriptPlugin.releaseTree(tree)

    expect(tree.rootNode).toBeNull()
  })
})
