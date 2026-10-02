/**
 * The signals that end a run someone stopped: Ctrl-C (`SIGINT`), a CI cancel or timeout
 * (`SIGTERM`), and a closed terminal (`SIGHUP`). `SIGKILL` cannot be caught, and leaves what it
 * leaves.
 */
const FATAL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

export type FatalSignal = (typeof FATAL_SIGNALS)[number]

/**
 * Run `cleanup` if the process is stopped by a signal before `release` is called.
 *
 * Node's default action for these signals ends the process without running pending `finally`
 * blocks, so state a `finally` would have removed — a registered git worktree and its checkout —
 * outlives the run. A listener replaces that default, so this one does the cleanup
 * synchronously, removes itself, and raises the same signal again: with no listener left the
 * default applies, and the exit status stays 128+N, as if nothing had intercepted it.
 *
 * `cleanup` must be synchronous and must not throw; anything it throws is swallowed, because
 * the process is going down either way and the signal is the fact the caller needs to see.
 * `reraise` is for tests, which cannot let the signal reach the test runner.
 */
export function cleanUpOnFatalSignal(
  cleanup: () => void,
  reraise: (signal: FatalSignal) => void = (signal) => process.kill(process.pid, signal),
): () => void {
  const listeners = FATAL_SIGNALS.map((signal) => {
    const listener = () => {
      release()
      try {
        cleanup()
      } catch {
        // The signal is what this process ends on; a cleanup failure must not replace it.
      }
      reraise(signal)
    }
    process.on(signal, listener)
    return [signal, listener] as const
  })
  function release(): void {
    for (const [signal, listener] of listeners) process.off(signal, listener)
  }
  return release
}
