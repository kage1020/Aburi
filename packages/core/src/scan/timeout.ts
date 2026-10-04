import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
} from "@aburi/types"
import { CoreError } from "../errors"

/** Default per-call classify timeout in milliseconds, per effect-plugin.md. */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 50

/** Bounds enforced by the config schema — kept here so callers can validate before invoking. */
export const CLASSIFY_TIMEOUT_MIN_MS = 10
export const CLASSIFY_TIMEOUT_MAX_MS = 5000

/**
 * A single overrun observation. Aggregated into `stats.effectClassifyTimeouts[]` so the IR
 * consumer can see which plugin is slow, and where. The classification itself is kept, so an
 * overrun changes that record and nothing else in the Document.
 *
 * `symbolId` names the owning Symbol so the event can be joined against the IR's Symbol map;
 * `budgetMs` is the clamped budget in effect (the schema's
 * `stats.effectClassifyTimeouts[].timeoutMs`: the budget the call ran past, not the wall
 * clock). The IR record keeps only those two and the plugin. `target`, `file`, `line` and
 * `elapsedMs` stay on `ScanResult.timeoutEvents`, for a `scan()` caller that wants to name the
 * call and say how far over it went, the way `ParseTimeoutEvent` does for a file.
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

/** Where the classified call sits, for the overrun event. */
export interface ClassifyWithTimeoutContext {
  /** Owning Symbol id — required so the timeout event can be joined against the IR. */
  symbolId: string
  /** POSIX-relative file path where the call sits. */
  file: string
}

/**
 * Run `plugin.classify(call, ctx)` against a wall-clock budget. The classifier must be
 * synchronous (effect-plugin.md §5.1.1), so the runtime cannot preempt it mid-execution and
 * the clock is read after the call returns. A classifier that breaks that contract by
 * returning a Promise fails the run.
 *
 * Returns the classification whether or not the call overran. By the time the clock is
 * read the work is done, so discarding the answer saves nothing, and keeping it is what
 * makes the IR depend on the source rather than on how busy the machine was: a cold first
 * call (module initialisation, JIT, a GC pause) is the usual overrun. An overrun fires the
 * `onTimeout` hook so `stats.effectClassifyTimeouts` can record it.
 */
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
    // §5.1.1). Attach a swallow-catch so the floating rejection does not blow up the process
    // under Node's --unhandled-rejections=strict mode, then surface the misconfiguration to
    // the caller.
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
  }

  return result
}

function clampTimeout(ms: number): number {
  if (ms < CLASSIFY_TIMEOUT_MIN_MS) return CLASSIFY_TIMEOUT_MIN_MS
  if (ms > CLASSIFY_TIMEOUT_MAX_MS) return CLASSIFY_TIMEOUT_MAX_MS
  return ms
}

/** Default per-file extraction budget in milliseconds, per lang-plugin.md. */
export const DEFAULT_PARSE_TIMEOUT_MS = 5000

/**
 * Lower bound the config schema states. Unlike the classify budget there is no upper one: a
 * caller who wants a whole minute for a pathological file is entitled to it, and the value
 * that matters for CI is the default.
 *
 * A config file cannot reach the clamp below — ajv rejects anything under this before the
 * value gets here. The clamp is for `scan()`'s other callers, who build a `Config` in code
 * and never meet the schema.
 */
export const PARSE_TIMEOUT_MIN_MS = 100

/**
 * One file abandoned for overrunning its budget. `budgetMs` is the clamped budget that was
 * in effect; `elapsedMs` is the wall clock the file had actually spent when the pipeline
 * next looked, which is always at least the budget and usually more — `ParseDeadline` says
 * why the two differ.
 */
export interface ParseTimeoutEvent {
  file: string
  budgetMs: number
  elapsedMs: number
}

/**
 * A per-file wall-clock budget covering parse + extract + walk. Cooperative, because the
 * plugin calls it spans are synchronous and cannot be interrupted once started — so the
 * budget bounds the work still to come rather than the work already running, and `elapsedMs`
 * at the moment of abandonment exceeds `budgetMs` by however long the last call took.
 * lang-plugin.md has the full statement of what that does and does not guarantee.
 */
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
