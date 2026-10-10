import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { symbolOf } from "./fixtures/ctx"

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
    ["an object literal's method", "export const o = { m() { a() } }", "o.m", "statement_block"],
    [
      "an object literal's property holding an arrow",
      "export const o = { f: () => { a() } }",
      "o.f",
      "statement_block",
    ],
    [
      "an object literal's property holding a concise arrow",
      "export const o = { f: (x: number) => x + 1 }",
      "o.f",
      "binary_expression",
    ],
    [
      "an object literal's property holding a wrapped arrow",
      "export const o = { f: (() => { a() }) as H }",
      "o.f",
      "statement_block",
    ],
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

describe("a binding whose body is the object literal it holds is described whole", () => {
  it.each([
    ["a const holding an object", "export const o = { m() { a() }, n: b() }", "o"],
    ["a const holding a wrapped object", "export const o = { m() { a() } } satisfies O", "o"],
  ])("%s", async (_label, source, name) => {
    expect(await normalizedHead(source, name)).toBe("lexical_declaration")
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
  // string is the parts, joined in source order. A class's head stays with its own class, so
  // that holds whether the class leads or follows.
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
    [
      "a class with a head, then a namespace",
      ["export class C extends Base { m() { a() } }", "export namespace C { export const x = 1 }"],
      [
        ["export class C extends Base { m() { a() } }"],
        ["export namespace C { export const x = 1 }"],
      ],
      "C",
    ],
    [
      "an interface, then a class with a head",
      [
        "export interface C { z: number }",
        "export abstract class C<T> extends Base { m() { a() } }",
      ],
      [
        ["export interface C { z: number }"],
        ["export abstract class C<T> extends Base { m() { a() } }"],
      ],
      "C",
    ],
  ])("%s", async (_label, merged, parts, name) => {
    const expected = await Promise.all(parts.map((lines) => alone(lines.join("\n"), name)))

    expect(await alone(merged.join("\n"), name)).toBe(expected.join(" "))
  })
})
