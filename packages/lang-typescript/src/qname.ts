import {
  DEFAULT_EXPORT_QNAME,
  makeLanguageId,
  makeMemberQname,
  makeNestedQname,
  makeSymbolId,
} from "@aburi/core"
import type { LanguageId, SymbolId } from "@aburi/types"

export const TYPESCRIPT_LANGUAGE_ID: LanguageId = makeLanguageId("ts")

export function makeTsSymbolId(file: string, qname: string): SymbolId {
  return makeSymbolId({ language: TYPESCRIPT_LANGUAGE_ID, file, qualifiedName: qname })
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
