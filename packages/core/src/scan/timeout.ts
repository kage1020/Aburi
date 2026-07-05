import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
} from "@aburi/types"

/** Default per-call classify timeout in milliseconds, per effect-plugin.md §5.1.1. */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 50

/** Bounds enforced by the config schema — kept here so callers can validate before invoking. */
export const CLASSIFY_TIMEOUT_MIN_MS = 10
export const CLASSIFY_TIMEOUT_MAX_MS = 5000

/**
 * A single soft-timeout observation. Aggregated into `stats.effectClassifyTimeouts[]`
 * so the IR consumer can detect run-to-run non-determinism ("this call classified
 * successfully in run 1 but timed out in run 2 → the plugin is on the edge").
 */
export interface ClassifyTimeoutEvent {
  plugin: string
  target: string
  file: string
  line: number
  elapsedMs: number
}

export interface ClassifyWithTimeoutOptions {
  timeoutMs?: number
  onTimeout?: (event: ClassifyTimeoutEvent) => void
}

/**
 * Run `plugin.classify(call, ctx)` under a soft wall-clock budget. The classifier is
 * expected to be synchronous (effect-plugin.md §5.1 recommends pure-function shape) so
 * the runtime cannot preempt it mid-execution — the check happens AFTER the call
 * returns. A classifier that violates the sync contract by returning a Promise is
 * caught and rejected the same way an overtime call is.
 *
 * Returns the classification when the call finished within budget, or `null` when it
 * timed out. Timeouts fire the `onTimeout` hook so `stats.effectClassifyTimeouts` can
 * accumulate the observation.
 */
export function classifyWithTimeout(
  plugin: EffectPlugin,
  call: CallCandidate,
  ctx: ClassifyContext,
  file: string,
  options: ClassifyWithTimeoutOptions = {},
): EffectClassification | null {
  const budget = clampTimeout(options.timeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS)
  const start = performance.now()
  const result = plugin.classify(call, ctx)
  const elapsed = performance.now() - start

  if (typeof result === "object" && result !== null && "then" in result) {
    // A classifier that returned a Promise violates the sync contract; treat it as a
    // timeout so the scan does not stall waiting on an unbounded microtask.
    options.onTimeout?.({
      plugin: plugin.manifest.name,
      target: call.target,
      file,
      line: call.line,
      elapsedMs: elapsed,
    })
    return null
  }

  if (elapsed > budget) {
    options.onTimeout?.({
      plugin: plugin.manifest.name,
      target: call.target,
      file,
      line: call.line,
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
