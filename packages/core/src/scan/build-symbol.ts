import type {
  Call,
  ComponentId,
  Confidence,
  Effect,
  Symbol as IRSymbol,
  LanguageId,
  OpaqueAstNode,
  Rule,
  SymbolCandidate,
} from "@aburi/types"
import { CoreError } from "../errors"
import { computeSymbolFingerprint, ZERO_FINGERPRINT } from "../fingerprint"
import { makeLanguageId } from "../id"
import { normalizeRuleStrings } from "../rule-text"

export function extractLanguageFromId(id: string): LanguageId {
  const colon = id.indexOf(":")
  if (colon <= 0) {
    throw new CoreError(
      `Symbol id "${id}" does not carry a language prefix; the language plugin violated the Symbol.id contract (\`<language>:<file>#<qname>\`).`,
      { code: "scan-plugin-misconfigured", value: id },
    )
  }
  return makeLanguageId(id.slice(0, colon))
}

export function buildDroppedSymbol(
  candidate: SymbolCandidate<OpaqueAstNode>,
  reason: string,
  language: LanguageId,
  component: ComponentId | null,
  frameworkConfidence: Confidence,
): IRSymbol {
  return {
    id: candidate.id,
    kind: candidate.kind,
    extKind: candidate.extKind,
    name: candidate.name,
    language,
    component,
    visibility: candidate.visibility,
    decorators: [...candidate.decorators],
    signature: candidate.signature,
    rules: [],
    effects: [],
    calls: [],
    source: candidate.source,
    fingerprint: { api: ZERO_FINGERPRINT, logic: ZERO_FINGERPRINT, syntax: ZERO_FINGERPRINT },
    confidence: frameworkConfidence,
    derivedBy: [...candidate.derivedBy],
    dropped: true,
    dropReason: reason,
  }
}

export interface BuildKeptSymbolInput {
  candidate: SymbolCandidate<OpaqueAstNode>
  language: LanguageId
  component: ComponentId | null
  rules: Rule[]
  effects: Effect[]
  calls: Call[]
  normalizedAstString: string
  confidence: Confidence
}

export function buildKeptSymbol(input: BuildKeptSymbolInput): IRSymbol {
  const base: IRSymbol = {
    id: input.candidate.id,
    kind: input.candidate.kind,
    extKind: input.candidate.extKind,
    name: input.candidate.name,
    language: input.language,
    component: input.component,
    visibility: input.candidate.visibility,
    decorators: [...input.candidate.decorators].sort((a, b) => a.line - b.line),
    signature: input.candidate.signature,
    rules: input.rules.map(normalizeRuleStrings).sort((a, b) => a.line - b.line),
    effects: [...input.effects].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    calls: [...input.calls].sort((a, b) => a.line - b.line),
    source: input.candidate.source,
    fingerprint: { api: ZERO_FINGERPRINT, logic: ZERO_FINGERPRINT, syntax: ZERO_FINGERPRINT },
    confidence: input.confidence,
    derivedBy: [...input.candidate.derivedBy],
    dropped: false,
    dropReason: null,
  }
  base.fingerprint = computeSymbolFingerprint({
    symbol: base,
    normalizedAstString: input.normalizedAstString,
  })
  return base
}
