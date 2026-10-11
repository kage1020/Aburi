import type { Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  enrich,
  makeClassSymbol,
  makeMethodSymbol,
  THIS_FOO_CALLER,
  thisFooFile,
} from "./fixtures/enrichment-ctx"
import { hoverPosition, hoverServer } from "./fixtures/mock-server"

/** The signature of `C.bar`, which calls `this.foo()`, when the hover on `foo` ends in `tags`. */
async function callerSignature(tags: string): Promise<Signature | null | undefined> {
  const enrichment = await enrich({
    ...thisFooFile(),
    serverFactory: hoverServer(() => ({
      contents: { kind: "markdown", value: `(method) C.foo(): void\n${tags}` },
    })),
  })
  return enrichment.symbols.find((s) => s.id === THIS_FOO_CALLER)?.signature
}

describe("inferredThrows from a hover's tags", () => {
  it.each<[string, string, string[] | null]>([
    ["no tag", "", null],
    ["a braced type", "@throws {NetworkError} on offline", ["NetworkError"]],
    ["a bare type name", "@throws Gone", ["Gone"]],
    ["a bare type name under `@throw`", "@throw Gone", ["Gone"]],
    ["a bare type name under `@exception`", "@exception Gone", ["Gone"]],
    ["a sentence", "@throws If the id is unknown.", null],
    ["a lower-case word", "@throws error", null],
    ["a type name followed by a description", "@throws NotFoundError when missing", null],
    ["a `{@link}` to a declaration", "@throws {@link NotFound} if missing", ["NotFound"]],
    ["a `{@linkcode}` to a declaration", "@throws {@linkcode NotFound}", ["NotFound"]],
    [
      "a `{@linkplain}` to a dotted path",
      "@throws {@linkplain errors.NotFound}",
      ["errors.NotFound"],
    ],
    ["a `{@link}` to a URL", "@throws {@link https://e.com/x | site}", null],
    ["two tags on one line", "@throws A @throws B", ["A", "B"]],
    ["a tag as the server renders it rather than as written", "*@throws* — Gone", null],
  ])("reads %s", async (_, tags, expected) => {
    const signature = await callerSignature(tags)

    if (expected === null) expect(Object.hasOwn(signature ?? {}, "inferredThrows")).toBe(false)
    else expect(signature?.inferredThrows).toEqual(expected)
    expect(signature?.throws).toEqual([])
  })

  it("merges what every hovered call declares into one sorted list without repeats", async () => {
    const enrichment = await enrich({
      symbols: [
        makeClassSymbol("src/a.ts", "C", 1),
        makeMethodSymbol("src/a.ts", "C", "foo", 2),
        makeMethodSymbol("src/a.ts", "C", "baz", 3),
        makeMethodSymbol("src/a.ts", "C", "bar", 4, [
          { target: "this.foo", line: 5 },
          { target: "this.baz", line: 6 },
        ]),
      ],
      fileContents: {
        "src/a.ts":
          "class C {\n  foo() {}\n  baz() {}\n  bar() {\n    this.foo()\n    this.baz()\n  }\n}",
      },
      serverFactory: hoverServer((params) =>
        hoverPosition(params).line === 4
          ? { contents: "(method) C.foo(): void\n@throws {B}\n@throws {A}" }
          : { contents: "(method) C.baz(): void\n@throws {A}" },
      ),
    })

    const caller = enrichment.symbols.find((s) => s.id === "ts:src/a.ts#C.bar")
    expect(caller?.signature?.inferredThrows).toEqual(["A", "B"])
  })
})
