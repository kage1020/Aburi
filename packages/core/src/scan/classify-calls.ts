import type {
  Call,
  CallCandidate,
  ComponentId,
  Config,
  Decorator,
  Effect,
  EffectPlugin,
  ImportEdge,
  LanguageId,
  OpaqueAstNode,
  OwnerDecorator,
  OwnerSummary,
  SourceFile,
  SymbolCandidate,
  VocabRegistry,
} from "@aburi/types"
import { makeCallSiteKey } from "../call-site"
import type { DropCFilter } from "./drop-c"
import { normalizeCallStrings } from "./normalize"
import {
  type ClassifyTimeoutEvent,
  type ClassifyWithTimeoutOptions,
  classifyWithTimeout,
} from "./timeout"
import type { VocabCheck } from "./vocab"

export interface ClassifyCallsInput {
  calls: readonly CallCandidate[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  config: Config
  component: ComponentId | null
  candidate: SymbolCandidate<OpaqueAstNode>
  file: SourceFile
  language: LanguageId
  imports: readonly ImportEdge[]
  dropCFilter: DropCFilter
  timeoutEvents: ClassifyTimeoutEvent[]
  vocab: VocabCheck
  classifyTimeoutMs?: number
}

function ownerDecorator(decorator: Decorator): OwnerDecorator {
  const { name, qualifier, boundary } = decorator
  return qualifier === undefined ? { name, boundary } : { name, qualifier, boundary }
}

export function classifyCalls(input: ClassifyCallsInput): {
  effects: Effect[]
  calls: Call[]
  dynamicCallSites: string[]
} {
  const classifiedEffects: Effect[] = []
  const survivingCalls: Call[] = []
  const dynamicCallSites: string[] = []
  const owner: OwnerSummary = {
    id: input.candidate.id,
    kind: input.candidate.kind,
    name: input.candidate.name,
    extKind: input.candidate.extKind,
    decorators: input.candidate.decorators.map(ownerDecorator),
    component: input.component,
  }

  for (const produced of input.calls) {
    const call = normalizeCallStrings(produced)
    if (input.dropCFilter.shouldDropCall(call)) continue

    const ctx = {
      owner,
      file: { path: input.file.path, imports: [...input.imports] },
      language: input.language,
      registry: input.registry,
      config: input.config,
    }

    let classified = false
    for (const effect of input.effects) {
      const timeoutOptions: ClassifyWithTimeoutOptions = {
        onTimeout: (event) => {
          input.timeoutEvents.push(event)
        },
      }
      if (input.classifyTimeoutMs !== undefined) timeoutOptions.timeoutMs = input.classifyTimeoutMs
      const result = classifyWithTimeout(
        effect,
        call,
        ctx,
        { symbolId: input.candidate.id, file: input.file.path },
        timeoutOptions,
      )
      if (result === null) continue
      input.vocab.effect({
        value: result.effectId,
        plugin: effect.manifest.name,
        file: input.file.path,
        line: call.line,
        symbol: input.candidate.id,
      })
      classifiedEffects.push({
        id: result.effectId,
        target: call.target,
        line: call.line,
        plugin: effect.manifest.name,
        confidence: result.confidence,
        derivedBy: result.derivedBy,
      })
      classified = true
      break
    }
    if (!classified) {
      survivingCalls.push({ target: call.target, line: call.line, resolved: null })
      if (call.dynamicReceiver === true) {
        dynamicCallSites.push(makeCallSiteKey(input.file.path, call.line, call.target))
      }
    }
  }

  classifiedEffects.sort(byTargetThenLine)
  survivingCalls.sort(byTargetThenLine)
  return { effects: classifiedEffects, calls: survivingCalls, dynamicCallSites }
}

function byTargetThenLine(
  a: { target: string; line?: number },
  b: { target: string; line?: number },
): number {
  if (a.target < b.target) return -1
  if (a.target > b.target) return 1
  return (a.line ?? 0) - (b.line ?? 0)
}
