import { describe, expect, it } from "vitest"
import { byId, symbolsOf } from "./fixtures/ctx"

/**
 * What a JSDoc `@throws` tag contributes to `signature.throws` (#330). `throws` is an input of
 * the api fingerprint, so a word of prose recorded as a type turns a reworded comment into an
 * API change. The rule favours recording nothing when a tag's text is not plainly a type.
 */

async function throwsOf(doc: string): Promise<readonly string[] | undefined> {
  const symbols = await symbolsOf(`${doc}\nexport function f() {}\n`)
  return byId(symbols, "#f").signature?.throws
}

describe("JSDoc @throws", () => {
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

  it("does not keep a lower-case or non-identifier word", async () => {
    expect(await throwsOf("/** @throws error */")).toEqual([])
    expect(await throwsOf("/** @throws - */")).toEqual([])
  })

  it("does not take a description that continues on the next line", async () => {
    expect(await throwsOf("/**\n * @throws Whenever\n *   the id is unknown.\n */")).toEqual([])
  })

  it("records the type of a braced tag and ignores its description", async () => {
    expect(await throwsOf("/** @throws {NotFoundError} if the row is missing */")).toEqual([
      "NotFoundError",
    ])
  })

  it("records the target of a TSDoc {@link}", async () => {
    expect(await throwsOf("/** @throws {@link NotFoundError} if the row is missing */")).toEqual([
      "NotFoundError",
    ])
    expect(await throwsOf("/** @throws {@linkcode errors.Gone | Gone} */")).toEqual(["errors.Gone"])
    expect(await throwsOf("/** @throws {@linkplain Conflict the conflict} */")).toEqual([
      "Conflict",
    ])
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
})
