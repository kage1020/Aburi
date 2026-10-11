/** Holds the thread for `ms` milliseconds, the way a slow synchronous plugin call would. */
export function spend(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
