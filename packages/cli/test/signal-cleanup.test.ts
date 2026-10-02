import { afterEach, describe, expect, it } from "vitest"
import { cleanUpOnFatalSignal, FATAL_SIGNALS } from "../src/signal-cleanup"

/**
 * Driven with `process.emit`, which calls the listeners without delivering a signal, and with
 * the re-raise replaced: a real one would end the test runner. That a real interrupt of
 * `aburi diff` leaves no worktree is asserted end to end in `e2e-integration`.
 */

const releases: (() => void)[] = []

afterEach(() => {
  for (const release of releases.splice(0)) release()
})

function listenerCounts(): number[] {
  return FATAL_SIGNALS.map((signal) => process.listenerCount(signal))
}

describe("cleanUpOnFatalSignal", () => {
  it.each(
    FATAL_SIGNALS,
  )("cleans up on %s, stops listening, then re-raises the same signal", (signal) => {
    const before = listenerCounts()
    const events: string[] = []
    let atReraise: number[] = []
    releases.push(
      cleanUpOnFatalSignal(
        () => events.push("cleanup"),
        (raised) => {
          events.push(`reraise:${raised}`)
          atReraise = listenerCounts()
        },
      ),
    )
    expect(listenerCounts()).toEqual(before.map((count) => count + 1))

    process.emit(signal)

    expect(events).toEqual(["cleanup", `reraise:${signal}`])
    // Removed before the re-raise, or the re-raised signal would land on this listener again
    // instead of taking the default action and ending the process with 128+N.
    expect(atReraise).toEqual(before)
    expect(listenerCounts()).toEqual(before)
  })

  it("still re-raises, with its listeners already gone, when the cleanup throws", () => {
    const before = listenerCounts()
    const raised: string[] = []
    let atReraise: number[] = []
    releases.push(
      cleanUpOnFatalSignal(
        () => {
          throw new Error("worktree remove failed")
        },
        (signal) => {
          raised.push(signal)
          atReraise = listenerCounts()
        },
      ),
    )
    process.emit("SIGTERM")
    expect(raised).toEqual(["SIGTERM"])
    expect(atReraise).toEqual(before)
  })

  it("leaves the signal to another listener rather than re-raising past it", () => {
    const events: string[] = []
    const host = () => events.push("host")
    process.on("SIGINT", host)
    try {
      releases.push(
        cleanUpOnFatalSignal(
          () => events.push("cleanup"),
          () => events.push("reraise"),
        ),
      )
      process.emit("SIGINT")
      // The host saw the one delivery once; a re-raise would have run it a second time.
      expect(events).toEqual(["host", "cleanup"])
    } finally {
      process.off("SIGINT", host)
    }
  })

  it.each(
    FATAL_SIGNALS,
  )("does nothing on %s once released, as after a run that finished on its own", (signal) => {
    const before = listenerCounts()
    const events: string[] = []
    const release = cleanUpOnFatalSignal(
      () => events.push("cleanup"),
      () => events.push("reraise"),
    )
    release()
    expect(listenerCounts()).toEqual(before)
    process.emit(signal)
    expect(events).toEqual([])
  })
})
