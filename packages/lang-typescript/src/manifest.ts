import type { LangManifest } from "@aburi/types"

/**
 * Manifest for `@aburi/lang-typescript`. The registry validates this at load time; the
 * shape is locked to `LangManifest` so a mismatch shows up as a compile-time error rather
 * than at run time.
 *
 * `derivedByPrefixes` names the language-level rationales this plugin attaches to each
 * SymbolCandidate.derivedBy. Every value `extractSymbols` emits must sit under one of these
 * prefixes — `fp-extension-impl.md` FP-A3 puts it the other way round: at least one entry
 * must identify the emitting plugin under a prefix it owns, which is what
 * `VocabRegistry.findDerivedByOwner` resolves.
 *
 * **The registry does not check that**, though this comment used to say it did. It validates
 * the manifest's own field and refuses two plugins declaring overlapping prefixes; nothing
 * compares an emitted `derivedBy` against the list. So the list is kept by hand, and a token
 * missing from it is a Symbol no plugin owns rather than a load-time error.
 */
export const langTypescriptManifest: LangManifest = {
  $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
  name: "lang-typescript",
  version: "0.0.0",
  type: "lang",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [
      "export-keyword",
      "export-default",
      "variable-assigned-function",
      "class-method",
      "field-assigned-function",
      "static-method",
      "interface-declaration",
      "type-alias",
      "namespace-declaration",
      "enum-declaration",
      "constructor-declaration",
      "destructured-binding",
      "accessor-declaration",
      "declaration-merged",
    ],
    frameworks: [],
  },
  capabilities: {
    wasmHeapPerWorkerMB: 256,
  },
}
