import { describe, expect, it } from "vitest"
import { langTypescriptPlugin, parseTypescriptFile } from "../src/index"
import { TYPESCRIPT_LANGUAGE_ID } from "../src/qname"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * `LanguagePlugin.languageId` is the `LanguageId` this plugin stamps on every Symbol id
 * (`<language>:<file>#<qname>`), and it is what `@aburi/core` projects into
 * `IR.workspace.languages`. The manifest name (`lang-typescript`) is a *plugin ref*,
 * resolved as a module specifier and outside the `LanguageId` grammar, so the two are not
 * interchangeable: a manifest name in this field yields an IR its own frozen schema
 * rejects. Both halves are pinned here — the declared value, and the value the extractor
 * actually writes.
 */
describe("langTypescriptPlugin.languageId", () => {
  it("is the LanguageId, not the manifest name", () => {
    expect(langTypescriptPlugin.languageId).toBe("ts")
    expect(langTypescriptPlugin.languageId).not.toBe(langTypescriptPlugin.manifest.name)
  })

  it("satisfies the LanguageId grammar from aburi.ir.v1", () => {
    expect(langTypescriptPlugin.languageId).toMatch(/^[a-z][a-z0-9]*$/)
  })

  it("is single-sourced with the qname builder's language constant", () => {
    expect(langTypescriptPlugin.languageId).toBe(TYPESCRIPT_LANGUAGE_ID)
  })

  it("matches the prefix the plugin actually writes onto Symbol ids", async () => {
    const source = "export function alpha() {}\n"
    const parsed = await parseTypescriptFile({ path: "src/a.ts", content: source })
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
