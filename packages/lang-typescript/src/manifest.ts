import type { LangManifest } from "@aburi/types"

/**
 * Manifest for `@aburi/lang-typescript`. The registry validates this at load time; the
 * shape is locked to `LangManifest` so a mismatch shows up as a compile-time error rather
 * than at run time.
 *
 * `derivedByPrefixes` names the language-level rationales this plugin attaches to each
 * SymbolCandidate.derivedBy. Every value used by extractSymbols must sit under one of
 * these prefixes; the registry cross-checks that at load time.
 */
export const langTypescriptManifest: LangManifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
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
      "static-method",
      "interface-declaration",
      "type-alias",
      "namespace-declaration",
      "enum-declaration",
      "constructor-declaration",
    ],
    frameworks: [],
  },
  capabilities: {
    wasmHeapPerWorkerMB: 256,
  },
}
