import { describe, expect, it } from "vitest"
import { walkFirstSymbol } from "./fixtures/ctx"

async function callsIn(body: string) {
  return (await walkFirstSymbol(`export async function f() { ${body} }`)).calls
}

function expectEverySegmentNamed(calls: readonly { target: string }[]) {
  for (const { target } of calls) {
    for (const segment of target.split(".")) expect(segment).toMatch(/^[^\s()]+$/)
  }
}

describe("a callee the walk can name", () => {
  it.each([
    ["a bare identifier", "save()", "save"],
    ["a qualified receiver", "svc.save()", "svc.save"],
    ["`this`", "this.save()", "this.save"],
    ["`super`", "super.save()", "super.save"],
    ["a parenthesized identifier", "(svc).save()", "svc.save"],
    ["a non-null assertion, which still names a binding", "svc!.save()", "svc!.save"],
    ["a non-null assertion on a member of `this`", "this.repo!.save()", "this.repo!.save"],
    ["a dynamic import", 'return import("./m")', "import"],
    ["`import.meta`", 'return import.meta.resolve("./m")', "import.meta.resolve"],
    ["`new.target`", "return new.target.g()", "new.target.g"],
    ["a string-literal index", 'prisma["user"].create({ data })', "prisma.user.create"],
    ["an escaped index, decoded", 'prisma["us\\u0065r"].create({})', "prisma.user.create"],
    [
      "a template index that substitutes nothing",
      "prisma[`user`].create({})",
      "prisma.user.create",
    ],
    ["an optionally-chained index", 'prisma?.["user"].create({})', "prisma.user.create"],
    ["a literal index the callee itself is written with", 'handlers["run"]()', "handlers.run"],
    ["a literal index in the method's slot", 'prisma.user["create"]({})', "prisma.user.create"],
    ["literal indexes in both slots", 'prisma["user"]["create"]({})', "prisma.user.create"],
    ["a name behind `as`", "(x as Foo).m()", "x.m"],
    ["a name behind `satisfies`", "(x satisfies Foo).m()", "x.m"],
    ["a name behind an old-style assertion", "(<Foo>x).m()", "x.m"],
    ["a name behind `as` a dotted type", "(emitter as Foo.Bar).update(x)", "emitter.update"],
    ["a member path behind `as`", "(this.repo as Repo).save()", "this.repo.save"],
    ["a name behind `as` a type that spells a spread", "(x as [...T]).map(g)", "x.map"],
    ["a name behind `as` a type that spans lines", "(x as {\n    a: string\n  }).m()", "x.m"],
    ["`this` behind `as`", "(this as any).m()", "this.m"],
    ["a name behind two assertions", "(x as unknown as Foo).m()", "x.m"],
    ["a callee behind `as`", "(f as Fn)()", "f"],
    ["a constructor behind `as`", "return new (X as any)()", "X"],
    ["a non-null assertion around `as`", "(x as Foo)!.save()", "x!.save"],
    ["a non-null method behind `as`", "(x as Foo).m!()", "x.m!"],
    ["a non-null assertion around parentheses", "(x)!.save()", "x!.save"],
    ["a non-null assertion after a comment", "x /* c */!.m()", "x!.m"],
    [
      "a non-null assertion on a literal index",
      'prisma["user"]!.create({})',
      "prisma.user!.create",
    ],
    [
      "a non-null assertion on a chain over lines",
      "this.repo\n    .items!.save()",
      "this.repo.items!.save",
    ],
  ])("names %s and flags nothing", async (_label, body, target) => {
    const calls = await callsIn(body)

    expect(calls.map((c) => [c.target, c.dynamicReceiver])).toEqual([[target, undefined]])
    expectEverySegmentNamed(calls)
  })
})

describe("a receiver the walk cannot name is flagged dynamic", () => {
  it.each([
    ["a call", "getRepo().save(x)", "getRepo.save"],
    ["a call deep in the chain", "getRepo().users.save()", "getRepo.users.save"],
    ["a call behind a non-null assertion", "getRepo()!.save()", "getRepo.save"],
    ["a call, though the index after it folds", 'getRepo()["user"].save()', "getRepo.user.save"],
    ["a parenthesized expression", "(a ?? b).save()", "<computed>.save"],
    ["a parenthesized non-null assertion", "(svc!).save()", "svc!.save"],
    ["a non-null assertion behind `as`", "(x! as Foo).m()", "x!.m"],
    ["an identifier index", "prisma[model].create({})", "prisma.<computed>.create"],
    ["a numeric index", "items[0].save()", "items.<computed>.save"],
    ["a substituting template index", `prisma[\`\${m}s\`].create({})`, "prisma.<computed>.create"],
    ["a literal that is not one segment", 'obj["a-b"].m()', "obj.<computed>.m"],
    ["a literal that spells a qualified name", 'obj["a.b"].m()', "obj.<computed>.m"],
    ["a literal that spells a private name", 'obj["#v"].m()', "obj.<computed>.m"],
    ["an empty literal", 'obj[""].m()', "obj.<computed>.m"],
    ["a literal only half of which parsed", 'obj["a\\u12b"].m()', "obj.<computed>.m"],
    [
      "an index the parser recovered",
      'prisma["user" "audit"].create({})',
      "prisma.<computed>.create",
    ],
    ["a computed callee", "handlers[name]()", "handlers.<computed>"],
    ["a computed method on a named receiver", "prisma.user[verb]({})", "prisma.user.<computed>"],
    ["each bracket of a chain on its own evidence", 'a["b"][x]["c"].run()', "a.b.<computed>.c.run"],
    ["an array literal", "return [...names].sort()", "<computed>.sort"],
    [
      "a nested array literal",
      "return [...new Set([...a, ...b])].forEach(g)",
      "<computed>.forEach",
    ],
    ["an awaited import", "return (await import('../m')).run()", "<computed>.run"],
    ["a string literal", "return 'Loading...'.toUpperCase()", "<computed>.toUpperCase"],
    ["a number literal", "return (.5).toFixed(2)", "<computed>.toFixed"],
    ["an object literal", "return ({...x}).toString()", "<computed>.toString"],
    ["a template literal", "return `a..b`.trim()", "<computed>.trim"],
    ["a constructed instance", "return new Date().getTime()", "<computed>.getTime"],
    ["an IIFE", "(async () => {\n    await load()\n  })()", "<computed>"],
    ["an array literal behind `as`", "return ([...a] as string[]).map(g)", "<computed>.map"],
    ["an array literal behind `!`", "return [...a]!.map(g)", "<computed>.map"],
  ])("flags %s", async (_label, body, target) => {
    const calls = await callsIn(body)

    expect(calls.find((c) => c.target === target)?.dynamicReceiver).toBe(true)
    expectEverySegmentNamed(calls)
  })

  it("keeps the calls inside an IIFE", async () => {
    expect(
      (await callsIn("(async () => {\n    await load()\n  })()")).map((c) => c.target),
    ).toEqual(["<computed>", "load"])
  })
})
