import { describe, expect, it } from "vitest"
import { langTypescriptPlugin } from "../src/index"
import { TYPESCRIPT_LANGUAGE_ID } from "../src/qname"
import { makeExtractionCtx, parseSource, requireTree } from "./fixtures/ctx"

describe("langTypescriptPlugin.languageId", () => {
  it("is the LanguageId the qname builder stamps, not the manifest name", () => {
    expect(langTypescriptPlugin.languageId).toBe("ts")
    expect(langTypescriptPlugin.languageId).toBe(TYPESCRIPT_LANGUAGE_ID)
    expect(langTypescriptPlugin.languageId).not.toBe(langTypescriptPlugin.manifest.name)
    expect(langTypescriptPlugin.languageId).toMatch(/^[a-z][a-z0-9]*$/)
  })

  it("matches the prefix the plugin actually writes onto Symbol ids", async () => {
    const source = "export function alpha() {}\n"
    const parsed = await parseSource(source)
    const symbols = langTypescriptPlugin.extractSymbols(
      requireTree(parsed.tree),
      makeExtractionCtx("src/a.ts", source),
    )
    expect(symbols.length).toBeGreaterThan(0)
    for (const symbol of symbols) {
      expect(symbol.id.startsWith(`${langTypescriptPlugin.languageId}:`)).toBe(true)
    }
  })
})
