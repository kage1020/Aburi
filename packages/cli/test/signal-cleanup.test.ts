import { afterEach, describe, expect, it } from "vitest"
import { cleanUpOnFatalSignal, type FatalSignal } from "../src/signal-cleanup"

/**
 * Driven with `process.emit`, which calls the listeners without delivering a signal, and with
 * the re-raise replaced: a real one would end the test runner. That a real interrupt of
 * `aburi diff` leaves no worktree is asserted end to end in `e2e-integration`.
 */

const SIGNALS: readonly FatalSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"]
const releases: (() => void)[] = []

afterEach(() => {
  for (const release of releases.splice(0)) release()
})

function listenerCounts(): number[] {
  return SIGNALS.map((signal) => process.listenerCount(signal))
}

describe("cleanUpOnFatalSignal", () => {
  it.each(SIGNALS)("cleans up on %s, stops listening, then re-raises the same signal", (signal) => {
    const before = listenerCounts()
    const events: string[] = []
    releases.push(
      cleanUpOnFatalSignal(
        () => events.push("cleanup"),
        (raised) => events.push(`reraise:${raised}`),
      ),
    )
    expect(listenerCounts()).toEqual(before.map((count) => count + 1))

    process.emit(signal)

    // Removed before the re-raise, or the re-raised signal would land on this listener again
    // instead of taking the default action and ending the process with 128+N.
    expect(events).toEqual(["cleanup", `reraise:${signal}`])
    expect(listenerCounts()).toEqual(before)
  })

  it("still re-raises when the cleanup throws", () => {
    const raised: string[] = []
    releases.push(
      cleanUpOnFatalSignal(
        () => {
          throw new Error("worktree remove failed")
        },
        (signal) => raised.push(signal),
      ),
    )
    process.emit("SIGTERM")
    expect(raised).toEqual(["SIGTERM"])
  })

  it("does nothing once released, as after a run that finished on its own", () => {
    const before = listenerCounts()
    const events: string[] = []
    const release = cleanUpOnFatalSignal(
      () => events.push("cleanup"),
      () => events.push("reraise"),
    )
    release()
    expect(listenerCounts()).toEqual(before)
    // With no listener of ours, an emit reaches only whatever else is registered.
    expect(events).toEqual([])
  })
})
