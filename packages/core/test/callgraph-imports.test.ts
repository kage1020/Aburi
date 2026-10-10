import { importEdge } from "@aburi/test-support"
import type { ImportEdge, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { resolveCallGraph } from "../src/callgraph"
import { makeLanguageId } from "../src/id"
import { type ImportClause, importsOf, withCalls } from "./fixtures/callgraph"
import { makeSymbol } from "./fixtures/ir"

describe("import scope", () => {
  it.each<[string, string, ImportClause, string]>([
    [
      "a named import",
      "helper",
      { source: "./util", symbols: ["helper"] },
      "ts:src/util.ts#helper",
    ],
    [
      "an aliased import, by its exported name",
      "h",
      { source: "./util", symbols: ["helper as h"] },
      "ts:src/util.ts#helper",
    ],
    [
      "a namespace import, under the local binding rather than the module's basename",
      "helpers.helper",
      { source: "./my-utilities", symbols: "*", namespaceBinding: "helpers" },
      "ts:src/my-utilities.ts#helper",
    ],
  ])("resolves the callee bound by %s", (_binding, target, edge, to) => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target, line: 4 }])
    const result = resolveCallGraph({
      symbols: [caller, makeSymbol(to)],
      importsByFile: importsOf("src/a.ts", edge),
    })
    expect(result.edges.map((e) => [e.to, e.confidence])).toEqual([[to, "high"]])
  })

  it("ignores a dynamic import", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 4 }])
    const callee = makeSymbol("ts:src/util.ts#helper")
    const result = resolveCallGraph({
      symbols: [caller, callee],
      importsByFile: importsOf("src/a.ts", {
        source: "./util",
        symbols: ["helper"],
        dynamic: true,
      }),
    })
    expect(result.edges).toEqual([])
  })

  it("answers each caller from its own directory and language when they share a specifier", () => {
    const py = { language: makeLanguageId("py") }
    const symbols = [
      withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 4 }]),
      withCalls("ts:lib/a.ts#caller", [{ target: "helper", line: 4 }]),
      withCalls("py:src/a.py#caller", [{ target: "helper", line: 4 }], py),
      makeSymbol("ts:src/repo.ts#helper"),
      makeSymbol("ts:lib/repo.ts#helper"),
      makeSymbol("py:src/repo.py#helper", py),
    ]
    const importsByFile = new Map<string, readonly ImportEdge[]>(
      ["src/a.ts", "lib/a.ts", "src/a.py"].map((file) => [
        file,
        [importEdge({ source: "./repo", symbols: ["helper"] })],
      ]),
    )
    const result = resolveCallGraph({ symbols, importsByFile, fileExtensions: ["ts", "py"] })
    expect(result.edges.map((edge) => [edge.from, edge.to])).toEqual([
      ["py:src/a.py#caller", "py:src/repo.py#helper"],
      ["ts:lib/a.ts#caller", "ts:lib/repo.ts#helper"],
      ["ts:src/a.ts#caller", "ts:src/repo.ts#helper"],
    ])
  })

  describe("a relative specifier reaches the file TypeScript would", () => {
    function resolveFrom(
      callerFile: string,
      specifier: string,
      calleeFiles: readonly string[],
      fileExtensions?: readonly string[],
    ): string | null {
      const caller = withCalls(`ts:${callerFile}#caller`, [{ target: "helper", line: 4 }])
      const result = resolveCallGraph({
        symbols: [caller, ...calleeFiles.map((file) => makeSymbol(`ts:${file}#helper`))],
        importsByFile: importsOf(callerFile, { source: specifier, symbols: ["helper"] }),
        ...(fileExtensions === undefined ? {} : { fileExtensions }),
      })
      return result.edges[0]?.to ?? null
    }

    it.each([
      ["./repo", "src/repo/index.ts"],
      ["./repo.js", "src/repo.ts"],
      ["./repo.js", "src/repo.tsx"],
      ["./repo.jsx", "src/repo.tsx"],
      ["./repo.mjs", "src/repo.mts"],
      ["./repo.cjs", "src/repo.cts"],
      ["./repo/index.js", "src/repo/index.ts"],
      ["../repo.js", "repo.ts"],
      ["./repo.js", "src/repo.js"],
      [".", "src/index.ts"],
      ["./", "src/index.ts"],
      ["..", "index.ts"],
      ["../", "index.ts"],
      ["./repo/..", "src/index.ts"],
      ["./repo.ts", "src/repo.ts"],
    ])("%s from src/a.ts resolves to %s", (specifier, file) => {
      expect(resolveFrom("src/a.ts", specifier, [file])).toBe(`ts:${file}#helper`)
    })

    it("`.` from a file at the workspace root reaches the root index", () => {
      expect(resolveFrom("a.ts", ".", ["index.ts"])).toBe("ts:index.ts#helper")
    })

    // Both files present, so each row holds one step of the order rather than only the set.
    it.each([
      ["./repo", ["src/repo.js", "src/repo.ts"], "src/repo.ts"],
      ["./repo", ["src/repo/index.ts", "src/repo.ts"], "src/repo.ts"],
      ["./repo.js", ["src/repo.js", "src/repo.ts"], "src/repo.ts"],
      ["./repo.js", ["src/repo.tsx", "src/repo.ts"], "src/repo.ts"],
      ["./repo.js", ["src/repo.jsx", "src/repo.js"], "src/repo.js"],
      ["./repo.js", ["src/repo.js", "src/repo.tsx"], "src/repo.tsx"],
      ["./repo.jsx", ["src/repo.ts", "src/repo.tsx"], "src/repo.tsx"],
      ["./repo.jsx", ["src/repo.jsx", "src/repo.ts"], "src/repo.ts"],
      ["./repo.jsx", ["src/repo.js", "src/repo.jsx"], "src/repo.jsx"],
      ["./repo.mjs", ["src/repo.mjs", "src/repo.mts"], "src/repo.mts"],
      ["./repo.cjs", ["src/repo.cjs", "src/repo.cts"], "src/repo.cts"],
    ])("%s with %j present resolves to %s", (specifier, files, expected) => {
      expect(resolveFrom("src/a.ts", specifier, files)).toBe(`ts:${expected}#helper`)
    })

    it("probes an extensionless specifier in `fileExtensions` order", () => {
      const files = ["src/repo.ts", "src/repo.js"]
      expect(resolveFrom("src/a.ts", "./repo", files, ["js", "ts"])).toBe("ts:src/repo.js#helper")
    })

    it("reaches `.ts` and `.js` from `./repo.jsx`, as TypeScript's `.jsx` arm does", () => {
      expect(resolveFrom("src/a.ts", "./repo.jsx", ["src/repo.ts"])).toBe("ts:src/repo.ts#helper")
      expect(resolveFrom("src/a.ts", "./repo.jsx", ["src/repo.js"])).toBe("ts:src/repo.js#helper")
    })

    it("falls back to a directory's index for a specifier with an extension, as TypeScript does outside ESM mode", () => {
      expect(resolveFrom("src/a.ts", "./repo.js", ["src/repo.js/index.ts"])).toBe(
        "ts:src/repo.js/index.ts#helper",
      )
    })

    it("does not read `./repo.mjs` as `repo.ts`: only the `.js` spelling maps to `.ts`", () => {
      expect(resolveFrom("src/a.ts", "./repo.mjs", ["src/repo.ts"])).toBeNull()
    })

    it.each([
      "./",
      ".",
      "./repo/..",
    ])("probes only the directory's index for %s, never the sibling file `<dir>.<ext>`", (specifier) => {
      expect(resolveFrom("src/a.ts", specifier, ["src.ts"])).toBeNull()
    })

    it("takes a path written with a non-emitted extension as written, ahead of any other candidate", () => {
      const files = ["src/repo.tsx", "src/repo.ts.ts", "src/repo.ts"]
      expect(resolveFrom("src/a.ts", "./repo.ts", files)).toBe("ts:src/repo.ts#helper")
    })

    it("probes the file as written whatever the probe list holds, and filters only the other sources", () => {
      expect(resolveFrom("src/a.ts", "./repo.js", ["src/repo.js"], ["ts"])).toBe(
        "ts:src/repo.js#helper",
      )
      expect(resolveFrom("src/a.ts", "./repo.js", ["src/repo.tsx"], ["ts", "js"])).toBeNull()
    })
  })

  describe("a default import resolves to the module's default export", () => {
    function resolvedOf(target: string, symbols: string[], callees: IRSymbol[]) {
      const caller = withCalls("ts:src/a.ts#caller", [{ target, line: 6 }])
      const result = resolveCallGraph({
        symbols: [caller, ...callees],
        importsByFile: importsOf("src/a.ts", { source: "./x", symbols }),
      })
      return {
        edges: result.edges.map((edge) => [edge.to, edge.confidence]),
        unresolved: result.diagnostics.map((d) => [d.bucket, d.candidates]),
      }
    }

    it.each([
      [
        "an anonymous default export",
        makeSymbol("ts:src/x.ts#<default>", { derivedBy: ["export-default"] }),
      ],
      [
        "a `<default>` Symbol that carries no `export-default`, as a plugin reading only the declaration emits it",
        makeSymbol("ts:src/x.ts#<default>"),
      ],
    ])("reaches %s", (_what, anon) => {
      expect(resolvedOf("inc", ["default as inc"], [anon])).toEqual({
        edges: [["ts:src/x.ts#<default>", "high"]],
        unresolved: [],
      })
    })

    it("reaches a named default export imported under another name", () => {
      const makeApp = makeSymbol("ts:src/x.ts#makeApp", { derivedBy: ["export-default"] })
      expect(resolvedOf("createApp", ["default as createApp"], [makeApp])).toEqual({
        edges: [["ts:src/x.ts#makeApp", "high"]],
        unresolved: [],
      })
    })

    it("composes a dotted tail past the default export's own name, not the local one", () => {
      const svc = makeSymbol("ts:src/x.ts#Svc", { kind: "class", derivedBy: ["export-default"] })
      const run = makeSymbol("ts:src/x.ts#Svc::run", { kind: "method" })
      expect(resolvedOf("S.run", ["default as S"], [svc, run])).toEqual({
        edges: [["ts:src/x.ts#Svc::run", "high"]],
        unresolved: [],
      })
    })

    it("does not take a named export that happens to share the local name", () => {
      const createClient = makeSymbol("ts:src/x.ts#createClient", { derivedBy: ["export-default"] })
      const connect = makeSymbol("ts:src/x.ts#connect")
      const callees = [createClient, connect]
      expect(resolvedOf("connect", ["default as connect"], callees)).toEqual({
        edges: [["ts:src/x.ts#createClient", "high"]],
        unresolved: [],
      })
      expect(resolvedOf("connect", ["connect"], callees)).toEqual({
        edges: [["ts:src/x.ts#connect", "high"]],
        unresolved: [],
      })
    })

    it("leaves a module without a default export unresolved, bucketed `no-match`", () => {
      const connect = makeSymbol("ts:src/x.ts#connect")
      expect(resolvedOf("connect", ["default as connect"], [connect])).toEqual({
        edges: [],
        unresolved: [["no-match", []]],
      })
    })

    it("leaves two default exports unresolved, bucketed `ambiguous`, rather than taking one", () => {
      const a = makeSymbol("ts:src/x.ts#a", { derivedBy: ["export-default"] })
      const b = makeSymbol("ts:src/x.ts#b", { derivedBy: ["export-default"] })
      expect(resolvedOf("x", ["default as x"], [b, a])).toEqual({
        edges: [],
        unresolved: [["ambiguous", ["ts:src/x.ts#a", "ts:src/x.ts#b"]]],
      })
    })
  })
})
