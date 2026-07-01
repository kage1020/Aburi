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

const LANGUAGE_ID = "ts"

export function makeTsSymbolId(file: string, qname: string): string {
  return makeSymbolId({ language: LANGUAGE_ID, file, qualifiedName: qname })
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
