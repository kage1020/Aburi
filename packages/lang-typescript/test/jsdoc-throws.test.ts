import { describe, expect, it } from "vitest"
import { byId, symbolsOf } from "./fixtures/ctx"

async function throwsOf(doc: string): Promise<readonly string[] | undefined> {
  const symbols = await symbolsOf(`${doc}\nexport function f() {}\n`)
  return byId(symbols, "#f").signature?.throws
}

describe("LP13a: JSDoc @throws", () => {
  it("records nothing for a free-text description", async () => {
    expect(await throwsOf("/** @throws If the id is unknown. */")).toEqual([])
    expect(await throwsOf("/** @throws Will throw an error if the argument is null. */")).toEqual(
      [],
    )
  })

  it("reads a reworded description the same as before", async () => {
    const before = await throwsOf("/**\n * Loads a record.\n * @throws If the id is unknown.\n */")
    const after = await throwsOf("/**\n * Loads a record.\n * @throws When the id is unknown.\n */")
    expect(after).toEqual(before)
  })

  it("does not take a type name that a description starts with", async () => {
    expect(await throwsOf("/** @throws NotFoundError when the row is missing */")).toEqual([])
  })

  it("keeps a bare type name that is the tag's whole text", async () => {
    expect(await throwsOf("/** @throws PaymentDeclined */")).toEqual(["PaymentDeclined"])
    expect(await throwsOf("/**\n * @throws Errors.NotFound\n * @returns nothing\n */")).toEqual([
      "Errors.NotFound",
    ])
  })

  it("keeps a bare type name written on the line after the tag", async () => {
    expect(await throwsOf("/**\n * @throws\n * NotFound\n */")).toEqual(["NotFound"])
  })

  it("does not keep a lower-case or non-identifier word", async () => {
    expect(await throwsOf("/** @throws error */")).toEqual([])
    expect(await throwsOf("/** @throws - */")).toEqual([])
  })

  it("holds only a bare name's first segment to upper case, and takes no trailing full stop", async () => {
    expect(await throwsOf("/** @throws Errors.notFound */")).toEqual(["Errors.notFound"])
    expect(await throwsOf("/** @throws errors.Gone */")).toEqual([])
    expect(await throwsOf("/** @throws {errors.Gone} */")).toEqual(["errors.Gone"])
    expect(await throwsOf("/** @throws PaymentDeclined. */")).toEqual([])
  })

  it("does not take a description that continues on the next line", async () => {
    expect(await throwsOf("/**\n * @throws Whenever\n *   the id is unknown.\n */")).toEqual([])
  })

  it("records the type of a braced tag and ignores its description", async () => {
    expect(await throwsOf("/** @throws {NotFoundError} if the row is missing */")).toEqual([
      "NotFoundError",
    ])
  })

  it("records what the braces hold verbatim, and nothing for empty ones", async () => {
    expect(await throwsOf("/** @throws {} */")).toEqual([])
    expect(await throwsOf("/** @throws { } */")).toEqual([])
    expect(await throwsOf("/** @throws {A | B} */")).toEqual(["A | B"])
    expect(await throwsOf("/** @throws {A}{B} */")).toEqual(["A"])
  })

  it("reads braces only when they open and close on the tag's own line", async () => {
    expect(await throwsOf("/**\n * @throws {Err\n * @returns {Bar}\n */")).toEqual([])
    expect(await throwsOf("/**\n * @throws\n * {NotFoundError} if missing\n */")).toEqual([])
  })

  it("records the target of a TSDoc {@link}", async () => {
    expect(await throwsOf("/** @throws {@link NotFoundError} if the row is missing */")).toEqual([
      "NotFoundError",
    ])
    expect(await throwsOf("/** @throws {@linkcode errors.Gone} */")).toEqual(["errors.Gone"])
    expect(await throwsOf("/** @throws {@linkcode errors.Gone | Gone} */")).toEqual(["errors.Gone"])
    expect(await throwsOf("/** @throws {@linkplain Conflict the conflict} */")).toEqual([
      "Conflict",
    ])
  })

  it("records nothing for a link that names no declaration, or another inline tag", async () => {
    expect(await throwsOf("/** @throws {@link} */")).toEqual([])
    expect(await throwsOf("/** @throws {@link https://e.com/x | site} */")).toEqual([])
    expect(await throwsOf("/** @throws {@inheritDoc} */")).toEqual([])
  })

  it("reads every tag in a block", async () => {
    const doc = [
      "/**",
      " * @throws {A} first",
      " * @exception B",
      " * @throw If something else.",
      " */",
    ].join("\n")
    expect(await throwsOf(doc)).toEqual(["A", "B"])
  })

  it("reads the singular @throw spelling, and no longer tag name", async () => {
    expect(await throwsOf("/** @throw Gone */")).toEqual(["Gone"])
    expect(await throwsOf("/** @throwsFoo */")).toEqual([])
  })

  it("ends a tag's text at a tag written later on the same line", async () => {
    expect(await throwsOf("/** @throws {A} first @throws {B} second */")).toEqual(["A", "B"])
    expect(await throwsOf("/** @throws A @throws B */")).toEqual(["A", "B"])
    expect(await throwsOf("/** @throws E @internal */")).toEqual(["E"])
    expect(await throwsOf("/** @internal @throws E */")).toEqual(["E"])
  })

  it("ends a tag's text where its comment closes, on one * or several", async () => {
    expect(await throwsOf("/** @throws Foo */")).toEqual(["Foo"])
    expect(await throwsOf("/** @throws Foo **/")).toEqual(["Foo"])
  })

  it("does not read into the next block of the run", async () => {
    expect(await throwsOf("/** @throws Gone */\n/** Explains Gone. */")).toEqual(["Gone"])
    expect(await throwsOf("/** @throws {Foo */\n/** @param x {y} */")).toEqual([])
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
