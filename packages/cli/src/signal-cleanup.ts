import { constants } from "node:os"

export const FATAL_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
] as const satisfies readonly NodeJS.Signals[]

export type FatalSignal = (typeof FATAL_SIGNALS)[number]

/** The work to do on a fatal signal. Synchronous: a returned promise is never awaited. */
export type SignalCleanup = () => void

export type Reraise = (signal: FatalSignal) => void

const defaultReraise: Reraise = (signal) => {
  if (process.platform === "win32") process.exit(128 + constants.signals[signal])
  process.kill(process.pid, signal)
}

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
