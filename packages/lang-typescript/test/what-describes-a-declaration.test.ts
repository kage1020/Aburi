import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { symbolOf } from "./fixtures/ctx"

/**
 * Which node `normalizeAst` describes a declaration by: its own body, or the whole declaration.
 *
 * The answer is read from the tree — a body that is a direct child of the declaration's node is
 * the declaration's own — so it rests on how each producer pairs the two. A producer that widened
 * its full node past its body's parent would move the `syntax` fingerprint of every Symbol of its
 * kind, and every test that only compares two normalized strings would still pass. So each
 * producer's answer is pinned here, by the node its string opens with.
 */

/** The node type a normalized string opens with: `(statement_block (…))` → `statement_block`. */
function headOf(normalized: string): string | undefined {
  return /^\((\w+)/.exec(normalized)?.[1]
}

async function normalizedHead(source: string, name: string): Promise<string | undefined> {
  return headOf(normalizeAst(await symbolOf(source, `ts:src/a.ts#${name}`)))
}

describe("a declaration with a body of its own is described by the body", () => {
  it.each([
    ["a function", "export function f() { a() }", "f", "statement_block"],
    ["a generator", "export function* f() { yield a() }", "f", "statement_block"],
    [
      "an overloaded function",
      "export function f(a: string): void\nexport function f(a: any) { a() }",
      "f",
      "statement_block",
    ],
    ["a const holding an arrow", "export const f = () => { a() }", "f", "statement_block"],
    [
      "a const holding a concise arrow",
      "export const f = (x: number) => x + 1",
      "f",
      "binary_expression",
    ],
    [
      "a const holding a function expression",
      "export const f = function () { a() }",
      "f",
      "statement_block",
    ],
    [
      "a const holding a wrapped arrow",
      "export const f = (() => { a() }) as H",
      "f",
      "statement_block",
    ],
    ["a class", "export class C { m() {} }", "C", "class_body"],
    ["an abstract class", "export abstract class C { abstract m(): void }", "C", "class_body"],
    ["a method", "export class C { m() { a() } }", "C.m", "statement_block"],
    ["a static method", "export class C { static m() { a() } }", "C::m", "statement_block"],
    [
      "a constructor",
      "export class C { constructor() { a() } }",
      "C.constructor",
      "statement_block",
    ],
    ["a field holding an arrow", "export class C { f = () => { a() } }", "C.f", "statement_block"],
    [
      "a field holding a wrapped arrow",
      "export class C { f = (() => { a() }) }",
      "C.f",
      "statement_block",
    ],
    [
      "a field holding a function expression",
      "export class C { f = function () { a() } }",
      "C.f",
      "statement_block",
    ],
    ["an interface", "export interface I { a: string }", "I", "interface_body"],
  ])("%s", async (_label, source, name, head) => {
    expect(await normalizedHead(source, name)).toBe(head)
  })
})

describe("a declaration with no body is described whole", () => {
  it.each([
    ["a type alias", "export type T = { a: string }", "T", "type_alias_declaration"],
    ["an enum", "export enum E { A }", "E", "enum_declaration"],
    ["a namespace", "export namespace N { export const x = 1 }", "N", "internal_module"],
    [
      "an abstract method",
      "export abstract class C { abstract m(): void }",
      "C.m",
      "abstract_method_signature",
    ],
    ["an ambient function", "declare function f(): void", "f", "function_signature"],
    ["a const holding a value", "export const x = 1", "x", "lexical_declaration"],
    ["a destructured binding", "export const { a } = obj", "a", "lexical_declaration"],
  ])("%s", async (_label, source, name, head) => {
    expect(await normalizedHead(source, name)).toBe(head)
  })
})

describe("a declaration whose body is a function written inside it is described whole", () => {
  it.each([
    ["a registration", "app.get('/x', () => { a() })", "app__get__$x__d0", "call_expression"],
    [
      "a const handing its call a function",
      "export const h = withAuth(() => { a() })",
      "h",
      "lexical_declaration",
    ],
    [
      "a const handing its call two",
      "export const h = pipe(() => { a() }, () => { b() })",
      "h",
      "lexical_declaration",
    ],
  ])("%s", async (_label, source, name, head) => {
    expect(await normalizedHead(source, name)).toBe(head)
  })
})

describe("a Symbol several declarations wrote describes each of them once", () => {
  // Positionless, so a declaration serializes the same alone and beside another: the merged
  // string is the parts, joined in source order.
  async function alone(source: string, name: string): Promise<string> {
    return normalizeAst(await symbolOf(source, `ts:src/a.ts#${name}`))
  }

  it.each([
    [
      "a getter and its setter",
      ["export class C {", "  get p() { return 1 }", "  set p(v) { b(v) }", "}"],
      [
        ["export class C {", "  get p() { return 1 }", "}"],
        ["export class C {", "  set p(v) { b(v) }", "}"],
      ],
      "C.p",
    ],
    [
      "an interface reopened",
      ["export interface I { a: string }", "export interface I { b: number }"],
      [["export interface I { a: string }"], ["export interface I { b: number }"]],
      "I",
    ],
    [
      "a const handing its call a function, then a type of the same name",
      ["export const N = z.string().refine((s: string) => check(s))", "export type N = string"],
      [["export const N = z.string().refine((s: string) => check(s))"], ["export type N = string"]],
      "N",
    ],
    [
      "a type, then a const handing its call two functions",
      ["export type N = string", "export const N = pipe(() => { a() }, () => { b() })"],
      [["export type N = string"], ["export const N = pipe(() => { a() }, () => { b() })"]],
      "N",
    ],
  ])("%s", async (_label, merged, parts, name) => {
    const expected = await Promise.all(parts.map((lines) => alone(lines.join("\n"), name)))

    expect(await alone(merged.join("\n"), name)).toBe(expected.join(" "))
  })
})
