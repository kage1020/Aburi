import { delta, symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { changedSymbols, diffOfEdit, editOf } from "./fixtures/scan"

const workspace = useScratchWorkspace("edit-axis")

const FILE = "src/a.ts"

/** `f` with this parameter list and a body that stays the same, so only the list differs. */
const withParams = (params: string) => `export function f(${params}): void {\n  use()\n}\n`

const perm = (role: string) =>
  [
    "interface User { role: string }",
    "",
    `export const canEdit = (u: User) => u.role === "${role}"`,
    "",
    "export function canEditBlock(u: User) {",
    `  return u.role === "${role}"`,
    "}",
    "",
  ].join("\n")

const ledger = (credit: string, gate: string, bound: string) =>
  [
    "export function applyCredit(balance: number, amount: number): number {",
    `  const next = balance ${credit} amount`,
    "  save(next)",
    "  return next",
    "}",
    "",
    "export function canDelete(isOwner: boolean, isAdmin: boolean): void {",
    `  audit(isOwner ${gate} isAdmin)`,
    "}",
    "",
    "export function sumAll(xs: number[]): number {",
    "  let total = 0",
    `  for (let i = 0; i ${bound} xs.length; i++) {`,
    "    total += xs[i]",
    "  }",
    "  return total",
    "}",
    "",
  ].join("\n")

const parser = (overload: string) =>
  [
    "export interface Config { name: string }",
    "",
    "export function parse(input: string): Config;",
    `export function parse(input: ${overload}): Config;`,
    "export function parse(input: any): any {",
    "  return decode(input)",
    "}",
    "",
  ].join("\n")

const repository = (...overloads: string[]) =>
  [
    "export class Repository {",
    ...overloads.map((overload) => `  find(id: ${overload}): User;`),
    "  find(id: any): any {",
    "    return load(id)",
    "  }",
    "}",
    "",
  ].join("\n")

const price = (guardNote: string, returnNote: string) =>
  [
    "export function price(qty: number, unit: number, member: boolean): number {",
    `  if (qty <= 0 ${guardNote}|| unit < 0) {`,
    '    throw new RangeError("bad input")',
    "  }",
    `  return member ? qty * unit * 0.9 ${returnNote}: qty * unit`,
    "}",
    "",
  ].join("\n")

const check = (...condition: string[]) =>
  [
    "export function check(user: { age: number; banned: boolean; role: string }) {",
    `  if (${condition.join("\n")}) {`,
    '    throw new Error("denied")',
    "  }",
    "  return user.role",
    "}",
    "",
  ].join("\n")

const SYNTAX_ONLY = delta({ syntaxChanged: true })

describe("an edit to what a caller passes is an api change", () => {
  it.each([
    [
      "a parenthesis-free arrow losing its parameter",
      'export const f = name => "hi"\n',
      'export const f = () => "hi"\n',
    ],
    [
      "an optional parameter made required",
      withParams("query?: string"),
      withParams("query: string"),
    ],
    [
      "an array parameter made a rest parameter",
      withParams("tags: string[]"),
      withParams("...tags: string[]"),
    ],
    ["a default dropped", withParams("limit: number = 10"), withParams("limit: number")],
  ])("reports %s", async (_label, before, after) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
    expect(changedSymbols(diff)).toMatchObject([
      { name: "f", apiChanged: true, logicChanged: false },
    ])
  })
})

describe("an edit to a parameter's default value is no api change", () => {
  it("keeps the api fingerprint, and the diff reports no change", async () => {
    const { base, head, diff } = await editOf(
      workspace,
      FILE,
      withParams("limit = 20"),
      withParams("limit = 10"),
    )

    expect(symbolNamed(head, "f").fingerprint.api).toBe(symbolNamed(base, "f").fingerprint.api)
    expect(diff.symbols).toEqual([])
    expect(diff.summary).toMatchObject({ changed: 0, unchanged: 1 })
  })
})

describe("an edit to a returned expression is a logic change", () => {
  it("reports a concise arrow and its block spelling alike", async () => {
    const diff = await diffOfEdit(workspace, FILE, perm("admin"), perm("guest"))

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 2 })
    expect(changedSymbols(diff).map((c) => [c.name, c.logicChanged])).toEqual([
      ["canEdit", true],
      ["canEditBlock", true],
    ])
  })
})

describe("an edit outside every rule and signature is a syntax-only change", () => {
  it.each([
    [
      "an operator in a statement, a call argument and a loop bound",
      ledger("+", "&&", "<"),
      ledger("-", "||", "<="),
      ["applyCredit", "canDelete", "sumAll"],
    ],
    [
      "a module-level function's retyped overload",
      parser("Buffer"),
      parser("Uint8Array"),
      ["parse"],
    ],
    [
      "a method's removed overload, on the method as well as its class",
      repository("string", "number"),
      repository("string"),
      ["Repository", "Repository.find"],
    ],
  ])("reports %s", async (_label, before, after, names) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)
    const changed = changedSymbols(diff)

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: names.length })
    expect(changed.map((c) => c.name).sort()).toEqual(names)
    for (const c of changed) expect(c).toMatchObject(SYNTAX_ONLY)
  })
})

describe("a formatting edit is no change", () => {
  it.each([
    [
      "comments written into a guard and a return",
      price("", ""),
      price("/* nothing to charge */ ", "/* member discount */ "),
    ],
    [
      "a guard re-wrapped over several lines",
      check('user.age < 18 || user.banned || user.role === "guest"'),
      check("", "    user.age < 18 ||", "    user.banned ||", '    user.role === "guest"', "  "),
    ],
  ])("leaves a Symbol whose only edit is %s unchanged", async (_label, before, after) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)

    expect(diff.symbols).toEqual([])
    expect(diff.summary).toMatchObject({ changed: 0, unchanged: 1 })
  })
})
