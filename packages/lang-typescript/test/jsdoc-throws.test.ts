import { describe, expect, it } from "vitest"
import { byId, symbolsOf } from "./fixtures/ctx"

async function throwsOf(doc: string): Promise<readonly string[] | undefined> {
  const symbols = await symbolsOf(`${doc}\nexport function f() {}\n`)
  return byId(symbols, "#f").signature?.throws
}

describe("JSDoc @throws", () => {
  it.each([
    ["a free-text description", "/** @throws If the id is unknown. */", []],
    [
      "a description that starts with a type name",
      "/** @throws NotFoundError when the row is missing */",
      [],
    ],
    [
      "a description that continues on the next line",
      "/**\n * @throws Whenever\n *   the id is unknown.\n */",
      [],
    ],
    ["a lower-case word", "/** @throws error */", []],
    ["a word that is no identifier", "/** @throws - */", []],
    ["a bare name followed by a full stop", "/** @throws PaymentDeclined. */", []],
    ["a bare name whose first segment is lower case", "/** @throws errors.Gone */", []],
    [
      "a bare type name that is the tag's whole text",
      "/** @throws PaymentDeclined */",
      ["PaymentDeclined"],
    ],
    [
      "a dotted bare name",
      "/**\n * @throws Errors.NotFound\n * @returns nothing\n */",
      ["Errors.NotFound"],
    ],
    [
      "a dotted bare name with a lower-case tail",
      "/** @throws Errors.notFound */",
      ["Errors.notFound"],
    ],
    ["a bare name on the line after the tag", "/**\n * @throws\n * NotFound\n */", ["NotFound"]],
    [
      "a braced type, and not its description",
      "/** @throws {NotFoundError} if the row is missing */",
      ["NotFoundError"],
    ],
    ["a braced type whatever its case", "/** @throws {errors.Gone} */", ["errors.Gone"]],
    ["empty braces", "/** @throws {} */", []],
    ["braces holding a space", "/** @throws { } */", []],
    ["what braces hold, verbatim", "/** @throws {A | B} */", ["A | B"]],
    ["only the first of two braced types", "/** @throws {A}{B} */", ["A"]],
    ["braces that close on another line", "/**\n * @throws {Err\n * @returns {Bar}\n */", []],
    ["braces that open on another line", "/**\n * @throws\n * {NotFoundError} if missing\n */", []],
    [
      "the target of a {@link}",
      "/** @throws {@link NotFoundError} if the row is missing */",
      ["NotFoundError"],
    ],
    ["the target of a {@linkcode}", "/** @throws {@linkcode errors.Gone} */", ["errors.Gone"]],
    [
      "a {@linkcode} target before its label",
      "/** @throws {@linkcode errors.Gone | Gone} */",
      ["errors.Gone"],
    ],
    [
      "the target of a {@linkplain}",
      "/** @throws {@linkplain Conflict the conflict} */",
      ["Conflict"],
    ],
    ["a link with no target", "/** @throws {@link} */", []],
    ["a link to a URL", "/** @throws {@link https://e.com/x | site} */", []],
    ["another inline tag", "/** @throws {@inheritDoc} */", []],
    ["the singular @throw spelling", "/** @throw Gone */", ["Gone"]],
    ["a longer tag name", "/** @throwsFoo */", []],
    [
      "every tag in a block",
      "/**\n * @throws {A} first\n * @exception B\n * @throw If something else.\n */",
      ["A", "B"],
    ],
    ["two braced tags on one line", "/** @throws {A} first @throws {B} second */", ["A", "B"]],
    ["two bare tags on one line", "/** @throws A @throws B */", ["A", "B"]],
    ["a tag ended by a later tag", "/** @throws E @internal */", ["E"]],
    ["a tag after another tag", "/** @internal @throws E */", ["E"]],
    ["a tag ended by the comment's close", "/** @throws Foo */", ["Foo"]],
    ["a tag ended by a close of several stars", "/** @throws Foo **/", ["Foo"]],
    ["one block of a run, not the next", "/** @throws Gone */\n/** Explains Gone. */", ["Gone"]],
    ["unclosed braces, not the next block's", "/** @throws {Foo */\n/** @param x {y} */", []],
  ])("reads %s", async (_label, doc, expected) => {
    expect(await throwsOf(doc)).toEqual(expected)
  })

  it("reads a long run of * or of blanks in linear time", async () => {
    const length = 100_000
    for (const doc of [
      `/** @throws Foo ${"*".repeat(length)}x */`,
      `/**\n * @throws Foo\n${" ".repeat(length)}x\n */`,
    ]) {
      const started = performance.now()
      expect(await throwsOf(doc)).toEqual([])
      expect(performance.now() - started).toBeLessThan(1_000)
    }
  })
})
