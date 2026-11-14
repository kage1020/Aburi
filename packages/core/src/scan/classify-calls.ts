import type {
  Call,
  CallCandidate,
  ComponentId,
  Config,
  DeclinedCall,
  Decorator,
  Effect,
  EffectClassification,
  EffectDecline,
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
import {
  type CallReceiverType,
  type CallSiteBinding,
  isThisBinding,
  makeCallSiteKey,
  makeSymbolCallKey,
} from "../call-site"
import { CoreError } from "../errors"
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
  declinedCalls: DeclinedCall[]
  thisBindings: CallSiteBinding[]
  receiverTypes: CallReceiverType[]
} {
  const classifiedEffects: Effect[] = []
  const survivingCalls: Call[] = []
  const dynamicCallSites: string[] = []
  const declinedCalls: DeclinedCall[] = []
  const thisBindings: CallSiteBinding[] = []
  const receiverTypes: CallReceiverType[] = []
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
    const declines: DeclinedCall[] = []
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
      if (isDecline(result, effect)) {
        declines.push({
          plugin: effect.manifest.name,
          symbolId: input.candidate.id,
          target: call.target,
          line: call.line,
          reason: declineReason(result, effect),
        })
        continue
      }
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
      declinedCalls.push(...declines)
      survivingCalls.push({ target: call.target, line: call.line, resolved: null })
      const key = makeCallSiteKey(input.file.path, call.line, call.target)
      if (call.dynamicReceiver === true) dynamicCallSites.push(key)
      if (isThisBinding(call.thisBinding)) thisBindings.push([key, call.thisBinding])
      if (typeof call.receiverType === "string" && call.receiverType.length > 0) {
        receiverTypes.push([
          makeSymbolCallKey(input.candidate.id, call.line, call.target),
          call.receiverType,
        ])
      }
    }
  }

  // Left in the plugin's order, which is source order: the Symbol sorts by line with a stable sort,
  // so two effects on one line keep the order they are written in, which `logic` reads.
  return {
    effects: classifiedEffects,
    calls: survivingCalls,
    dynamicCallSites,
    thisBindings,
    receiverTypes,
    declinedCalls,
  }
}

function isDecline(
  result: EffectClassification | EffectDecline,
  effect: EffectPlugin,
): result is EffectDecline {
  if (!Object.hasOwn(result, "declined")) return false
  if (!Object.hasOwn(result, "effectId")) return true
  // TypeScript accepts an object carrying both keys as either member of the union.
  throw new CoreError(
    `Effect plugin "${effect.manifest.name}" answered one call with both \`effectId\` and \`declined\`: classify() must return an EffectClassification, an EffectDecline or null, not both.`,
    { code: "scan-plugin-misconfigured", value: effect.manifest.name },
  )
}

function declineReason(decline: EffectDecline, effect: EffectPlugin): string {
  const reason: unknown = decline.declined
  if (typeof reason === "string" && reason.trim().length > 0) return reason.normalize("NFC")
  throw new CoreError(
    `Effect plugin "${effect.manifest.name}" declined a call with no reason: \`declined\` must be a non-empty string.`,
    { code: "scan-plugin-misconfigured", value: effect.manifest.name },
  )
}
