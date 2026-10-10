import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
} from "@aburi/types"
import { CoreError } from "../errors"

/** Default per-call classify timeout in milliseconds. */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 50

/** Bounds enforced by the config schema — kept here so callers can validate before invoking. */
export const CLASSIFY_TIMEOUT_MIN_MS = 10
export const CLASSIFY_TIMEOUT_MAX_MS = 5000

export interface ClassifyTimeoutEvent {
  plugin: string
  symbolId: string
  target: string
  file: string
  line: number
  budgetMs: number
  elapsedMs: number
}

export interface ClassifyWithTimeoutOptions {
  timeoutMs?: number
  onTimeout?: (event: ClassifyTimeoutEvent) => void
}

export interface ClassifyWithTimeoutContext {
  /** Owning Symbol id — required so the timeout event can be joined against the IR. */
  symbolId: string
  /** POSIX-relative file path where the call sits. */
  file: string
}

export function classifyWithTimeout(
  plugin: EffectPlugin,
  call: CallCandidate,
  ctx: ClassifyContext,
  location: ClassifyWithTimeoutContext,
  options: ClassifyWithTimeoutOptions = {},
): EffectClassification | null {
  const budget = clampTimeout(options.timeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS)
  const start = performance.now()
  const result = plugin.classify(call, ctx)
  const elapsed = performance.now() - start

  if (typeof result === "object" && result !== null && "then" in result) {
    void (result as unknown as PromiseLike<unknown>).then(
      () => undefined,
      () => undefined,
    )
    throw new CoreError(
      `Effect plugin "${plugin.manifest.name}" returned a Promise from classify(); the sync contract in effect-plugin.md requires a plain EffectClassification | null.`,
      { code: "scan-plugin-misconfigured", value: plugin.manifest.name },
    )
  }

  if (elapsed > budget) {
    options.onTimeout?.({
      plugin: plugin.manifest.name,
      symbolId: location.symbolId,
      target: call.target,
      file: location.file,
      line: call.line,
      budgetMs: budget,
      elapsedMs: elapsed,
    })
    return null
  }

  return result
}

function clampTimeout(ms: number): number {
  if (ms < CLASSIFY_TIMEOUT_MIN_MS) return CLASSIFY_TIMEOUT_MIN_MS
  if (ms > CLASSIFY_TIMEOUT_MAX_MS) return CLASSIFY_TIMEOUT_MAX_MS
  return ms
}

/** Default per-file extraction budget in milliseconds. */
export const DEFAULT_PARSE_TIMEOUT_MS = 5000

export const PARSE_TIMEOUT_MIN_MS = 100

export interface ParseTimeoutEvent {
  file: string
  budgetMs: number
  elapsedMs: number
}

export interface ParseDeadline {
  /** The clamped budget in effect for this file. */
  readonly budgetMs: number
  /** Wall clock spent since the deadline started. */
  elapsedMs(): number
  /** True once the budget is spent. */
  expired(): boolean
}

export function startParseDeadline(timeoutMs?: number): ParseDeadline {
  const configured = timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS
  const budgetMs = configured < PARSE_TIMEOUT_MIN_MS ? PARSE_TIMEOUT_MIN_MS : configured
  const start = performance.now()
  return {
    budgetMs,
    elapsedMs: () => performance.now() - start,
    expired: () => performance.now() - start >= budgetMs,
  }
}
