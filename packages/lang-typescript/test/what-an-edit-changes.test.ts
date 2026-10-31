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

const registry = (...fields: string[]) =>
  [
    "export class Registry {",
    ...fields.map((field) => `  ${field}`),
    "  static {",
    "    load()",
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

const returning = (open: string, close: string) =>
  [
    "export function total(a: number, b: number): number {",
    `  return ${open}compute(a, b)${close}`,
    "}",
    "",
    "export function larger(a: number, b: number): number {",
    `  return ${open}a > b ? a : b${close}`,
    "}",
    "",
  ].join("\n")

const accessor = (parameter: string) =>
  `export class C {\n  get x() {\n    return 1\n  }\n  set x(${parameter}: number) {\n    use()\n  }\n}\n`

const CONNECT = "function connect() {\n  return open()\n}\n"
const PAGE = "function Page() {\n  return render()\n}\n"

const SYNTAX_ONLY = delta({ syntaxChanged: true })

describe("an edit to what a caller passes or gets is an api change", () => {
  it.each([
    [
      "a parenthesis-free arrow losing its parameter",
      'export const f = name => "hi"\n',
      'export const f = () => "hi"\n',
      true,
    ],
    [
      "an optional parameter made required",
      withParams("query?: string"),
      withParams("query: string"),
      true,
    ],
    [
      "an array parameter made a rest parameter",
      withParams("tags: string[]"),
      withParams("...tags: string[]"),
      true,
    ],
    ["a parameter retyped", withParams("limit: number"), withParams("limit: string"), true],
    ["a default dropped", withParams("limit: number = 10"), withParams("limit: number"), true],
    [
      "a return type, outside the parameter list",
      "export function f(): void {\n  use()\n}\n",
      "export function f(): string {\n  use()\n}\n",
      false,
    ],
    [
      "a type parameter, outside the parameter list",
      "export function f(): void {\n  use()\n}\n",
      "export function f<T>(): void {\n  use()\n}\n",
      false,
    ],
  ])("reports %s, and on the syntax axis only an edit to the list", async (_label, before, after, syntaxChanged) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
    expect(changedSymbols(diff)).toMatchObject([
      { name: "f", apiChanged: true, logicChanged: false, syntaxChanged },
    ])
  })
})

describe("an edit to the names a declaration is exported under is an api change", () => {
  it.each([
    [
      "a name added to an export clause",
      "const handler = NextAuth(options)\nexport { handler as GET }\n",
      "const handler = NextAuth(options)\nexport { handler as GET, handler as DELETE }\n",
      "handler",
      { added: ["DELETE"], removed: [] },
    ],
    [
      "a clause renaming its export",
      `${CONNECT}export { connect as open }\n`,
      `${CONNECT}export { connect as start }\n`,
      "connect",
      { added: ["start"], removed: ["open"] },
    ],
    [
      "a default export made a named one",
      `export default ${PAGE}`,
      `export ${PAGE}`,
      "Page",
      { added: ["Page"], removed: ["default"] },
    ],
  ])("reports %s", async (_label, before, after, name, exportedAs) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
    expect(changedSymbols(diff)).toMatchObject([
      { name, apiChanged: true, logicChanged: false, exportedAs: { ...exportedAs, modified: [] } },
    ])
  })

  it("keeps the api fingerprint when a clause exports a declaration under its own name, as the keyword does", async () => {
    const { base, head } = await editOf(
      workspace,
      FILE,
      `export ${CONNECT}`,
      `${CONNECT}export { connect }\n`,
    )

    expect(symbolNamed(head, "connect").fingerprint.api).toBe(
      symbolNamed(base, "connect").fingerprint.api,
    )
  })
})

describe("an edit to a parameter's name, pattern or default value is a syntax-only change", () => {
  it.each([
    ["a default's value", withParams("limit = 20"), withParams("limit = 10"), ["f"]],
    [
      "a parameter renamed and unused",
      withParams("limit: number"),
      withParams("max: number"),
      ["f"],
    ],
    [
      "the key a destructured parameter reads",
      "export function pick({ a: b }: any) {\n  return b\n}\n",
      "export function pick({ c: b }: any) {\n  return b\n}\n",
      ["pick"],
    ],
    [
      "the hole an array parameter skips",
      "export function second([, b]: any[]) {\n  return b\n}\n",
      "export function second([b]: any[]) {\n  return b\n}\n",
      ["second"],
    ],
    [
      "an arrow's destructured parameter",
      "export const pick = ({ a: b }: any) => b\n",
      "export const pick = ({ c: b }: any) => b\n",
      ["pick"],
    ],
    [
      "a method's destructured parameter, on the method as well as its class",
      "export class C {\n  m({ a: b }: any) {\n    return b\n  }\n}\n",
      "export class C {\n  m({ c: b }: any) {\n    return b\n  }\n}\n",
      ["C", "C.m"],
    ],
    [
      "a constructor's default",
      "export class C {\n  constructor(a = 1) {\n    use(a)\n  }\n}\n",
      "export class C {\n  constructor(a = 2) {\n    use(a)\n  }\n}\n",
      ["C", "C.constructor"],
    ],
    [
      "a setter's parameter, behind the getter that leads the accessor",
      accessor("v"),
      accessor("w"),
      ["C", "C.x"],
    ],
    [
      "the parameter of a class field's function",
      "export class C {\n  h = (a: number) => use()\n}\n",
      "export class C {\n  h = (b: number) => use()\n}\n",
      ["C", "C.h"],
    ],
    [
      "the parameter of an object's method",
      "export const o = {\n  m(a: number) {\n    use()\n  },\n}\n",
      "export const o = {\n  m(b: number) {\n    use()\n  },\n}\n",
      ["o", "o.m"],
    ],
    [
      "the parameter of an object entry's function",
      "export const o = {\n  m: (a: number) => use(),\n}\n",
      "export const o = {\n  m: (b: number) => use(),\n}\n",
      ["o", "o.m"],
    ],
  ])("reports %s", async (_label, before, after, names) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)
    const changed = changedSymbols(diff)

    expect(changed.map((c) => c.name).sort()).toEqual(names)
    for (const c of changed) expect(c).toMatchObject(SYNTAX_ONLY)
  })

  it.each(["src/a.tsx", "src/a.js"])("reads the list alike in %s", async (file) => {
    const diff = await diffOfEdit(
      workspace,
      file,
      "export function f(limit = 20) {\n  use(limit)\n}\n",
      "export function f(limit = 10) {\n  use(limit)\n}\n",
    )

    expect(changedSymbols(diff)).toMatchObject([{ name: "f", ...SYNTAX_ONLY }])
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
    [
      "a field written beside a class's static block",
      registry(),
      registry("static items: string[] = []"),
      ["Registry"],
    ],
    [
      "parentheses a formatter puts around a returned call and a returned conditional",
      returning("", ""),
      returning("(\n    ", "\n  )"),
      ["larger", "total"],
    ],
    [
      "a concise conditional rewritten as a block that returns it in parentheses",
      "export const larger = (a: number, b: number): number => (a > b ? a : b)\n",
      "export const larger = (a: number, b: number): number => {\n  return (a > b ? a : b)\n}\n",
      ["larger"],
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
      "a lone arrow parameter put in parentheses",
      "export const inc = x => x + 1\n",
      "export const inc = (x) => x + 1\n",
      1,
    ],
    [
      "a lone parameter put in parentheses, on an arrow in a body",
      "export function ids(items: Item[]) {\n  return items.map(x => x.id)\n}\n",
      "export function ids(items: Item[]) {\n  return items.map((x) => x.id)\n}\n",
      1,
    ],
    [
      "a lone parameter put in parentheses, on a class field's arrow",
      "export class C {\n  h = x => use(x)\n}\n",
      "export class C {\n  h = (x) => use(x)\n}\n",
      2,
    ],
    [
      "a lone parameter put in parentheses, on an object entry's arrow",
      "export const o = {\n  m: x => use(x),\n}\n",
      "export const o = {\n  m: (x) => use(x),\n}\n",
      2,
    ],
    [
      "a lone parameter put in parentheses, on an arrow handed to a call",
      "export const handle = wrap(x => {\n  use(x)\n})\n",
      "export const handle = wrap((x) => {\n  use(x)\n})\n",
      1,
    ],
    [
      "a lone parameter put in parentheses, on a registration's handler",
      'app.get("/x", x => {\n  use(x)\n})\n',
      'app.get("/x", (x) => {\n  use(x)\n})\n',
      1,
    ],
    [
      "a trailing comma after the last parameter",
      withParams("a: string, b: number"),
      withParams("a: string, b: number,"),
      1,
    ],
    [
      "comments written into a guard and a return",
      price("", ""),
      price("/* nothing to charge */ ", "/* member discount */ "),
      1,
    ],
    [
      "a union parameter joined onto one line",
      "export function add(\n  provider:\n    | ClassProvider\n    | ValueProvider,\n): void {\n  use(provider)\n}\n",
      "export function add(provider: ClassProvider | ValueProvider): void {\n  use(provider)\n}\n",
      1,
    ],
    [
      "a union parameter of an overload joined onto one line",
      "export function parse(\n  input:\n    | Buffer\n    | string,\n): Config\nexport function parse(input: any): any {\n  return read(input)\n}\n",
      "export function parse(input: Buffer | string): Config\nexport function parse(input: any): any {\n  return read(input)\n}\n",
      1,
    ],
    [
      "an intersection written with a leading `&` joined onto one line",
      "export function add(\n  provider:\n    & Named\n    & Scoped,\n): void {\n  use(provider)\n}\n",
      "export function add(provider: Named & Scoped): void {\n  use(provider)\n}\n",
      1,
    ],
    [
      "a union inside a generic argument joined onto one line",
      "export function add(\n  parts: Array<\n    | ClassProvider\n    | ValueProvider\n  >,\n): void {\n  use(parts)\n}\n",
      "export function add(parts: Array<ClassProvider | ValueProvider>): void {\n  use(parts)\n}\n",
      1,
    ],
    [
      "an object type parameter joined onto one line",
      "export function load(\n  options: {\n    path: string\n    strict?: boolean\n  },\n): void {\n  use(options)\n}\n",
      "export function load(options: { path: string; strict?: boolean }): void {\n  use(options)\n}\n",
      1,
    ],
    [
      "a function type's parameters joined onto one line",
      "export function on(\n  handler: (\n    request: Request,\n    response: Response,\n  ) => void,\n): void {\n  use(handler)\n}\n",
      "export function on(handler: (request: Request, response: Response) => void): void {\n  use(handler)\n}\n",
      1,
    ],
    [
      "a guard re-wrapped over several lines",
      check('user.age < 18 || user.banned || user.role === "guest"'),
      check("", "    user.age < 18 ||", "    user.banned ||", '    user.role === "guest"', "  "),
      1,
    ],
    [
      "a method's union parameter joined onto one line, on the method as well as its class",
      "export class Module {\n  add(\n    provider:\n      | ClassProvider\n      | ValueProvider,\n  ): void {\n    use(provider)\n  }\n}\n",
      "export class Module {\n  add(provider: ClassProvider | ValueProvider): void {\n    use(provider)\n  }\n}\n",
      2,
    ],
  ])("leaves every Symbol unchanged when the only edit is %s", async (_label, before, after, unchanged) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)

    expect(diff.symbols).toEqual([])
    expect(diff.summary).toMatchObject({ changed: 0, unchanged })
  })
})
