import { constants } from "node:os"

export const FATAL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

export type FatalSignal = (typeof FATAL_SIGNALS)[number]

/** The work to do on a fatal signal. Synchronous: a returned promise is never awaited. */
export type SignalCleanup = () => void

export type Reraise = (signal: FatalSignal) => void

const defaultReraise: Reraise = (signal) => {
  if (process.platform === "win32") process.exit(128 + constants.signals[signal])
  process.kill(process.pid, signal)
}

/**
 * `first` puts `cleanup` ahead of the listeners already registered, for one whose effect the others'
 * output depends on.
 */
export function cleanUpOnFatalSignal(
  cleanup: SignalCleanup,
  reraise: Reraise = defaultReraise,
  { first = false }: { first?: boolean } = {},
): () => void {
  const listeners = FATAL_SIGNALS.map((signal) => {
    const listener = () => {
      // Released first, so a second Ctrl-C during a slow cleanup ends the process at once.
      release()
      try {
        cleanup()
      } catch {
        // The signal is what this process ends on; a cleanup failure must not replace it.
      }
      if (process.listenerCount(signal) > 0) return
      reraise(signal)
    }
    if (first) process.prependListener(signal, listener)
    else process.on(signal, listener)
    return [signal, listener] as const
  })
  function release(): void {
    for (const [signal, listener] of listeners) process.off(signal, listener)
  }
  return release
}
