import { constants } from "node:os"

/**
 * The signals that end a run someone stopped: Ctrl-C (`SIGINT`), a CI cancel or timeout
 * (`SIGTERM`), and a closed terminal (`SIGHUP`). `SIGKILL` cannot be caught, and leaves what it
 * leaves. `SIGQUIT` (Ctrl-\) and `SIGBREAK` (Ctrl-Break on Windows) are out of scope by choice:
 * neither is how a run is ordinarily stopped, and an interrupt through either leaves the same
 * state `SIGKILL` does.
 */
export const FATAL_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
] as const satisfies readonly NodeJS.Signals[]

export type FatalSignal = (typeof FATAL_SIGNALS)[number]

/** The work to do on a fatal signal. Synchronous: a returned promise is never awaited. */
export type SignalCleanup = () => void

/**
 * Ends the process on `signal` once the cleanup has run. The default does not return; a test
 * double does, which is the one difference between them.
 */
export type Reraise = (signal: FatalSignal) => void

/**
 * Raise `signal` against this process again, now that no listener of ours is registered.
 *
 * On POSIX the default action applies and the process ends on the signal, with 128+N. Windows
 * has no such default to fall back on: there `process.kill` on our own pid ends the process with
 * exit 1 for `SIGINT` / `SIGTERM`, indistinguishable from a runtime error, and throws `ENOSYS`
 * for `SIGHUP`. So Windows exits with the 128+N a POSIX shell would have reported instead.
 */
const defaultReraise: Reraise = (signal) => {
  if (process.platform === "win32") process.exit(128 + constants.signals[signal])
  process.kill(process.pid, signal)
}

/**
 * Run `cleanup` if the process is stopped by a signal before `release` is called.
 *
 * Node's default action for these signals ends the process without running pending `finally`
 * blocks, so state a `finally` would have removed — a registered git worktree and its checkout —
 * outlives the run. A listener replaces that default, so this one removes itself, does the
 * cleanup synchronously, and raises the same signal again: with no listener left the default
 * applies, and on POSIX the exit status stays 128+N, as if nothing had intercepted it. On
 * Windows the run exits with that same 128+N rather than dying of the signal (see
 * `defaultReraise`).
 *
 * The listener removes itself *before* the cleanup, by decision: a second Ctrl-C during a slow
 * cleanup then takes the default action and ends the process at once, so whoever is waiting is
 * never left with only `SIGKILL` as a way out. It also makes the listener impossible to re-enter.
 *
 * For a programmatic host: if the process still has another listener for the signal once ours is
 * gone, the re-raise is skipped. That listener has already seen this delivery and already
 * replaced the default action, so re-raising would only run it a second time; what the process
 * does next is the host's decision, as it was before this was registered.
 *
 * `cleanup` must be synchronous and must not throw; anything it throws is swallowed, because
 * the process is going down either way and the signal is the fact the caller needs to see.
 * `reraise` is for tests, which cannot let the signal reach the test runner.
 */
export function cleanUpOnFatalSignal(
  cleanup: SignalCleanup,
  reraise: Reraise = defaultReraise,
): () => void {
  const listeners = FATAL_SIGNALS.map((signal) => {
    const listener = () => {
      release()
      try {
        cleanup()
      } catch {
        // The signal is what this process ends on; a cleanup failure must not replace it.
      }
      if (process.listenerCount(signal) > 0) return
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
