/**
 * Qualified-name builders for the tree-sitter TypeScript surface. These wrap the core
 * id / qname primitives so extractSymbols does not need to know the plugin-specific
 * separator conventions.
 */
import {
  DEFAULT_EXPORT_QNAME,
  makeMemberQname,
  makeNestedQname,
  makeSymbolId,
  makeTopLevelQname,
} from "@aburi/core"
import type { LanguageId, SymbolId } from "@aburi/types"

/**
 * The `LanguageId` this plugin stamps before the colon of every Symbol id. It is also
 * what `LanguagePlugin.languageId` reports to `@aburi/core`, so the id prefix and the
 * value that lands in `IR.workspace.languages` cannot drift. Note this is a different
 * vocabulary from the manifest name (`lang-typescript`), which is a plugin ref.
 */
export const TYPESCRIPT_LANGUAGE_ID: LanguageId = "ts"

export function makeTsSymbolId(file: string, qname: string): SymbolId {
  return makeSymbolId({ language: TYPESCRIPT_LANGUAGE_ID, file, qualifiedName: qname })
}

export function topLevelQname(name: string): string {
  return makeTopLevelQname(name)
}

export function classMemberQname(
  ownerChain: readonly string[],
  member: string,
  kind: "instance" | "static",
): string {
  return makeMemberQname(ownerChain, member, kind)
}

export function nestedQname(segments: readonly string[]): string {
  return makeNestedQname(segments)
}

export function defaultExportQname(): string {
  return DEFAULT_EXPORT_QNAME
}
