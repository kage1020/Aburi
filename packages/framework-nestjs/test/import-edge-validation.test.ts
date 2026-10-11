import { decorator } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classifyDecorated, makeImport, makeNamespaceImport, NEST } from "./fixtures/symbol"

describe("classifyNestjsSymbol — inputs the language plugin should never hand over", () => {
  it("throws on an import edge with an empty module specifier, naming the file and line", () => {
    expect(() =>
      classifyDecorated("class", ["Controller"], [makeImport("", ["Controller"], 7)]),
    ).toThrow("framework-nestjs (src/a.ts, line 7): ImportEdge.source is empty")
  })

  it("throws on a broken edge sitting behind one that would have answered", () => {
    expect(() =>
      classifyDecorated(
        "class",
        ["Controller"],
        [makeImport(NEST, ["Controller"], 1), makeImport("", ["X"], 9)],
      ),
    ).toThrow(/line 9.*ImportEdge\.source is empty/)
  })

  it.each([
    [" as Ctrl", "an empty exported half"],
    ["Controller as ", "an empty local half"],
  ])("throws on the symbols entry %j, with %s", (entry) => {
    expect(() => classifyDecorated("class", ["Ctrl"], [makeImport(NEST, [entry], 3)])).toThrow(
      `framework-nestjs (src/a.ts, line 3): ImportEdge.symbols entry "${entry}" has an empty half`,
    )
  })

  it("throws on a namespace edge whose binding is present but empty", () => {
    expect(() =>
      classifyDecorated(
        "class",
        [decorator({ name: "Controller", qualifier: "nest" })],
        [makeNamespaceImport(NEST, "")],
      ),
    ).toThrow(/namespaceBinding is empty/)
  })

  it.each([
    ["", "empty"],
    [".a", "a leading dot"],
  ])("throws on the decorator qualifier %j, which is %s", (qualifier) => {
    expect(() =>
      classifyDecorated(
        "class",
        [decorator({ name: "Controller", qualifier })],
        [makeImport(NEST, ["Controller"])],
      ),
    ).toThrow(/unusable qualifier/)
  })

  it("does not read the import list for a Symbol that carries no decorators", () => {
    expect(classifyDecorated("class", [], [makeImport("", ["Controller"])])).toBeNull()
  })
})
