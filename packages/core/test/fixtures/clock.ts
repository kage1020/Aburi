/**
 * Spend `ms` of wall clock, really.
 *
 * The budgets the scan enforces are read between plugin calls rather than during them, so a
 * test that wants a call to overrun has to make it overrun — a mocked clock would exercise the
 * arithmetic and not the mechanism. A busy loop is the only thing that spends time a
 * synchronous plugin call would spend.
 *
 * What this buys is one-sided error. A test asserting that a budget *was* blown can only fail
 * in the direction of a machine spending more time, which is the direction that keeps it true;
 * a test asserting that one was *not* blown has to leave a margin over the amount spent, and
 * the ones in this repo leave one or two orders of magnitude.
 *
 * `spins` and the unreachable throw are the loop's observable effect: without them a compiler
 * or a later reader is free to conclude that a loop with an empty body does nothing.
 */
export function spend(ms: number): void {
  const until = performance.now() + ms
  let spins = 0
  while (performance.now() < until) spins++
  if (spins < 0) throw new Error("unreachable")
}
