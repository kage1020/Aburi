import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  component,
  errorFrom,
  makeCall,
  recordingLogger,
  useScratchWorkspace,
} from "@aburi/test-support"
import type { LanguagePlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  CoreError,
  languageFileDropPatterns,
  logicFingerprint,
  makeLanguageId,
  serializeCanonical,
  writeCanonicalIR,
} from "../../src"
import { spend } from "../fixtures/clock"
import {
  langManifest,
  oneSymbolPerFile,
  scanStubs,
  stubCandidate,
  stubEffectsPlugin,
  stubFrameworkPlugin,
  stubLanguagePlugin,
} from "../fixtures/plugins"

const workspace = useScratchWorkspace("scan-document")

/** `a.stub` declares `helper`, which writes, and `caller`, which calls `helper` on lines 2 and 3. */
async function callerAndHelper() {
  await workspace.writeSource("a.stub", "a")
  const language = stubLanguagePlugin({
    extractSymbols: () => [
      stubCandidate("caller", { file: "a.stub" }),
      stubCandidate("helper", { file: "a.stub" }),
    ],
    walkBody: (symbol) => ({
      rules: [],
      calls:
        symbol.name === "caller"
          ? [makeCall({ target: "helper", line: 2 }), makeCall({ target: "helper", line: 3 })]
          : [makeCall({ target: "db.save", line: 7 })],
    }),
  })
  const writes = stubEffectsPlugin("effects-db", (call) =>
    call.target === "db.save"
      ? { effectId: "db.write", confidence: "high", derivedBy: "effects-db:save" }
      : null,
  )
  return scanStubs(workspace.root, { languages: [language], effects: [writes] })
}

describe("scan — what it refuses", () => {
  it("refuses a workspace root that is not absolute", async () => {
    const error = await errorFrom(CoreError, () => scanStubs("relative/root"))
    expect(error.code).toBe("scan-workspace-not-absolute")
  })
})

describe("scan — the Document it assembles", () => {
  it("names the generator, and every plugin sorted by name with a grammar revision for a language", async () => {
    const { ir } = await scanStubs(workspace.root, {
      languages: [stubLanguagePlugin({ manifest: langManifest("lang-zeta") })],
      frameworks: [stubFrameworkPlugin("framework-mid")],
      effects: [stubEffectsPlugin("effects-alpha", () => null)],
    })

    expect(ir.generator).toEqual({
      name: "@aburi/core",
      version: "0.0.0",
      plugins: [
        { name: "effects-alpha", type: "effects", version: "0.0.0", grammarRevision: null },
        { name: "framework-mid", type: "framework", version: "0.0.0", grammarRevision: null },
        { name: "lang-zeta", type: "lang", version: "0.0.0", grammarRevision: "pending@0.0.0" },
      ],
    })
  })

  it("takes the generator's name and version from the caller", async () => {
    const { ir } = await scanStubs(workspace.root, {
      generator: { name: "aburi", version: "1.2.3" },
    })
    expect([ir.generator.name, ir.generator.version]).toEqual(["aburi", "1.2.3"])
  })

  it("lists each language once, sorted, beside the workspace managers it was given", async () => {
    const other = stubLanguagePlugin({
      manifest: langManifest("lang-other"),
      languageId: makeLanguageId("other"),
      fileExtensions: [".other"],
    })
    const managers = [{ tool: "pnpm", roots: ["apps/a"] }]
    const { ir } = await scanStubs(workspace.root, {
      languages: [stubLanguagePlugin(), other],
      workspaceManagers: managers,
    })

    expect(ir.workspace).toEqual({ root: ".", managers, languages: ["other", "stub"] })
  })

  it("sorts the components by id, and writes an absent description as null", async () => {
    const { description: _omitted, ...web } = component({
      id: "web",
      name: "web",
      roots: ["apps/web"],
    })
    const api = component({ id: "api", name: "api", roots: ["apps/api"], description: "orders" })

    const { ir } = await scanStubs(workspace.root, { components: [web, api] })

    expect(ir.components.map((c) => [c.id, c.description])).toEqual([
      ["api", "orders"],
      ["web", null],
    ])
  })

  it("collapses repeated calls between two Symbols into one outbound dependency", async () => {
    const { ir } = await callerAndHelper()

    expect(
      ir.symbols.find((s) => s.name === "caller")?.calls.map((c) => [c.line, c.resolved]),
    ).toEqual([
      [2, "stub:a.stub#helper"],
      [3, "stub:a.stub#helper"],
    ])
    expect(ir.dependencies).toEqual([
      {
        from: "stub:a.stub#caller",
        to: "stub:a.stub#helper",
        via: "call",
        direction: "outbound",
        effect: null,
      },
    ])
  })

  it("keeps each kept Symbol's logic fingerprint in step with the effects it inherited", async () => {
    const { ir } = await callerAndHelper()
    const caller = ir.symbols.find((s) => s.name === "caller")

    expect(caller?.effects.map((e) => [e.id, e.propagated])).toEqual([["db.write", true]])
    for (const symbol of ir.symbols) expect(symbol.fingerprint.logic).toBe(logicFingerprint(symbol))
  })

  it("records a classifier that overran its budget in the stats, by plugin, Symbol and budget", async () => {
    await workspace.writeSource("a.stub", "a")
    const slow = stubEffectsPlugin("effects-slow", () => {
      spend(30)
      return null
    })
    const language = oneSymbolPerFile({
      walkBody: () => ({ rules: [], calls: [makeCall({ target: "db.query" })] }),
    })

    const { ir } = await scanStubs(workspace.root, {
      config: { classifyTimeoutMs: 10 },
      languages: [language],
      effects: [slow],
    })

    expect(ir.stats.effectClassifyTimeouts).toEqual([
      { plugin: "effects-slow", symbolId: "stub:a.stub#a_stub", timeoutMs: 10 },
    ])
  })

  it("leaves out the files a language plugin drops, uncounted", async () => {
    await workspace.writeSource("a.stub", "a")
    await workspace.writeSource("gen/b.stub", "b")
    const { ir } = await scanStubs(workspace.root, {
      languages: [oneSymbolPerFile({ fileDropPatterns: ["gen/**"] })],
    })

    expect(ir.symbols.map((s) => s.source.file)).toEqual(["a.stub"])
    expect(ir.stats.totalFiles).toBe(1)
  })

  it("reads a file whose extension its plugin declared in another Unicode form", async () => {
    await workspace.writeSource("a.t\u015b", "a")
    const parsed: string[] = []
    const language = stubLanguagePlugin({
      fileExtensions: [".ts\u0301"],
      parseFile: async (file) => {
        parsed.push(file.path)
        return { tree: {}, errors: [], imports: [] }
      },
    })

    const { skipped } = await scanStubs(workspace.root, { languages: [language] })

    expect(parsed).toEqual(["a.t\u015b"])
    expect(skipped).toEqual([])
  })
})

describe("scan — a plugin that does not free its parse trees", () => {
  it("is warned about once, then counted, and every file still reaches the Document", async () => {
    for (const name of ["a", "b", "c"]) await workspace.writeSource(`${name}.stub`, name)
    const logger = recordingLogger()
    const leaking: LanguagePlugin = {
      ...oneSymbolPerFile(),
      releaseTree: () => {
        throw new Error("heap is gone")
      },
    }

    const { ir, treeReleaseFailures } = await scanStubs(workspace.root, {
      languages: [leaking],
      logger,
    })

    expect(ir.symbols).toHaveLength(3)
    expect(treeReleaseFailures.map((f) => f.file)).toEqual(["a.stub", "b.stub", "c.stub"])
    expect(logger.warnings).toEqual([
      expect.stringContaining(
        "Plugin lang-stub did not release the parse tree for a.stub: heap is gone.",
      ),
      "Plugin lang-stub failed to release 3 parse trees over this run.",
    ])
  })
})

describe("languageFileDropPatterns", () => {
  it("gathers every language's file-drop patterns in plugin order", () => {
    expect(
      languageFileDropPatterns([
        stubLanguagePlugin({ fileDropPatterns: ["**/*.d.stub", "gen/**"] }),
        stubLanguagePlugin(),
        stubLanguagePlugin({ fileDropPatterns: ["**/*.min.stub"] }),
      ]),
    ).toEqual(["**/*.d.stub", "gen/**", "**/*.min.stub"])
  })
})

describe("writeCanonicalIR", () => {
  it.each([
    "pretty",
    "compact",
  ] as const)("writes the %s canonical bytes, creating the directory, and returns them", async (format) => {
    await workspace.writeSource("a.stub", "a")
    const { ir } = await scanStubs(workspace.root, { languages: [oneSymbolPerFile()] })
    const out = join(workspace.root, "out", "deep", "aburi.ir.json")

    const written = await writeCanonicalIR(ir, out, { format })

    expect(written).toBe(serializeCanonical(ir, { format }))
    expect(await readFile(out, "utf8")).toBe(written)
  })

  it("writes pretty bytes when no format is named", async () => {
    const { ir } = await scanStubs(workspace.root)
    const written = await writeCanonicalIR(ir, join(workspace.root, "aburi.ir.json"))
    expect(written).toBe(serializeCanonical(ir, { format: "pretty" }))
  })
})
