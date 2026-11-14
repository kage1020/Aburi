/** Holds the thread for `ms` milliseconds, the way a slow synchronous plugin call would. */
export function spend(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export interface CostGrowthOptions {
  /** Rounds to take the median of. */
  readonly rounds?: number
  /** Each side repeats until this much time has passed, so a call far below the clock's grain still times. */
  readonly sampleMs?: number
  /** A round at or above this ratio is timed once more, in case a stall landed in it. */
  readonly retryAt?: number
}

export interface CostGrowth {
  readonly median: number
  readonly ratios: readonly number[]
}

/**
 * How many times longer a call of `large` takes than a call of `small`. Each round times both in
 * turn, alternating which goes first, so a slower runner slows both sides alike and a scheduling
 * stall spoils one round rather than the median.
 */
export function costGrowth(
  small: () => void,
  large: () => void,
  { rounds = 5, sampleMs = 5, retryAt = Number.POSITIVE_INFINITY }: CostGrowthOptions = {},
): CostGrowth {
  meanCost(small, sampleMs)
  const measure = (largeFirst: boolean): number => {
    if (largeFirst) {
      const largeCost = meanCost(large, sampleMs)
      return largeCost / meanCost(small, sampleMs)
    }
    const smallCost = meanCost(small, sampleMs)
    return meanCost(large, sampleMs) / smallCost
  }
  const ratios: number[] = []
  for (let round = 0; round < rounds; round++) {
    const ratio = measure(round % 2 === 0)
    ratios.push(ratio < retryAt ? ratio : measure(round % 2 === 0))
  }
  return { median: median(ratios), ratios }
}

function meanCost(run: () => void, sampleMs: number): number {
  let calls = 0
  const started = performance.now()
  let elapsed = 0
  do {
    run()
    calls++
    elapsed = performance.now() - started
  } while (elapsed < sampleMs)
  return elapsed / calls
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}
