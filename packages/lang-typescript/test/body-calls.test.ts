import { describe, expect, it } from "vitest"
import { BACKSLASH, walkFirstSymbol } from "./fixtures/ctx"

async function callsIn(body: string) {
  return (await walkFirstSymbol(`export async function f(x: any) { ${body} }`)).calls
}

describe("the calls a body makes", () => {
  it.each([
    ["a member chain, as the chain it spells", "prisma.user.create()", ["prisma.user.create"]],
    ["the call nested in a call-only return", "return foo(bar())", ["foo", "bar"]],
  ])("records %s", async (_label, body, targets) => {
    expect((await callsIn(body)).map((c) => c.target)).toEqual(targets)
  })

  it.each([
    ["an awaited call", "await doThing()", { inAwait: true, inNew: false }],
    ["a construction", "new MyClass()", { inAwait: false, inNew: true }],
    ["a plain call", "doThing()", { inAwait: false, inNew: false }],
  ])("marks %s", async (_label, body, flags) => {
    expect(await callsIn(body)).toMatchObject([flags])
  })
})

describe("a call's arguments", () => {
  it.each([
    ["a literal of each kind", "doThing('users', 42, x)", 3, ["users", "42", null]],
    [
      "a backtick literal, unless it substitutes",
      `doThing(\`users\`, \`a/\${x}\`)`,
      2,
      ["users", null],
    ],
    ["an escape, as the character it names", `db.query("SELECT${BACKSLASH}t1")`, 1, ["SELECT\t1"]],
    ["a line comment after the last one", "doThing(\n  users, // soft delete\n)", 1, [null]],
    ["a comment leading the list", "doThing(/* the table */ 'users', x)", 2, ["users", null]],
    ["a comment between two", "doThing(a, /* and */ b)", 2, [null, null]],
    ["nothing but a comment", "doThing(/* nothing */)", 0, []],
    ["a trailing comma", 'save(x, "draft",)', 2, [null, "draft"]],
  ])("reads %s", async (_label, body, argumentCount, literalArgs) => {
    expect(await callsIn(body)).toMatchObject([{ argumentCount, literalArgs }])
  })

  it("keeps two literal arguments apart when neither could be read at all", async () => {
    const calls = await callsIn(
      [`db.query("${BACKSLASH}u12b/a")`, `db.query("${BACKSLASH}u12b/b")`].join("\n"),
    )

    expect(calls.map((c) => c.literalArgs)).toEqual([
      [`${BACKSLASH}u12b/a`],
      [`${BACKSLASH}u12b/b`],
    ])
  })
})
