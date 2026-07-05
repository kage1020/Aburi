import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
} from "@aburi/types"
import { CoreError } from "../errors"

/** Default per-call classify timeout in milliseconds, per effect-plugin.md §5.1.1. */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 50

/** Bounds enforced by the config schema — kept here so callers can validate before invoking. */
export const CLASSIFY_TIMEOUT_MIN_MS = 10
export const CLASSIFY_TIMEOUT_MAX_MS = 5000

/**
 * A single soft-timeout observation. Aggregated into `stats.effectClassifyTimeouts[]`
 * so the IR consumer can detect run-to-run non-determinism ("this call classified
 * successfully in run 1 but timed out in run 2 → the plugin is on the edge").
 *
 * `symbolId` names the owning Symbol so the timeout event can be joined against the
 * IR's Symbol map; `budgetMs` is the configured cap in effect at the time (matches the
 * schema's `stats.effectClassifyTimeouts[].timeoutMs` semantics — "the budget that was
 * blown", not the actual wall-clock). `elapsedMs` is the observed wall-clock, kept for
 * CI signal wiring.
 */
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

/**
 * Run `plugin.classify(call, ctx)` under a soft wall-clock budget. The classifier is
 * expected to be synchronous (effect-plugin.md §5.1.1 recommends pure-function shape) so
 * the runtime cannot preempt it mid-execution — the check happens AFTER the call
 * returns. A classifier that violates the sync contract by returning a Promise is
 * caught and rejected the same way an overtime call is.
 *
 * Returns the classification when the call finished within budget, or `null` when it
 * timed out. Timeouts fire the `onTimeout` hook so `stats.effectClassifyTimeouts` can
 * accumulate the observation.
 */
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
    // A classifier that returned a Promise violates the sync contract (effect-plugin.md
    // §5.1 pure-function shape). Attach a swallow-catch so the floating rejection does
    // not blow up the process under Node's --unhandled-rejections=strict mode, then
    // surface the misconfiguration to the caller.
    void (result as unknown as PromiseLike<unknown>).then(
      () => undefined,
      () => undefined,
    )
    throw new CoreError(
      `Effect plugin "${plugin.manifest.name}" returned a Promise from classify(); the sync contract in effect-plugin.md §5.1.1 requires a plain EffectClassification | null.`,
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
