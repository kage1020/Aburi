import type { ScanProgress } from "@aburi/core"
import { describe, expect, it } from "vitest"
import { type DiffProgress, showDiffProgress, showScanProgress } from "../src/progress"
import type { Terminal } from "../src/terminal"

/** A terminal that records each progress line it is asked for, and whether at once. */
function recordingTerminal() {
  const drawn: Array<[text: string, now: boolean]> = []
  const terminal: Terminal = {
    say: () => {},
    progress: (text, now = false) => {
      drawn.push([text, now])
    },
    endProgress: () => {},
  }
  return { terminal, drawn }
}

const extracting = (done: number, total: number): ScanProgress => ({
  phase: "extracting",
  done,
  total,
})

describe("showScanProgress", () => {
  it("names each phase, drawing a new phase and the last file at once and a count in between when due", () => {
    const { terminal, drawn } = recordingTerminal()
    const show = showScanProgress(terminal)

    for (const progress of [
      { phase: "discovering" },
      extracting(0, 2),
      extracting(1, 2),
      extracting(2, 2),
      { phase: "resolving" },
    ] as const) {
      show(progress)
    }

    expect(drawn).toEqual([
      ["discovering files…", true],
      ["extracting 0/2 files", true],
      ["extracting 1/2 files", false],
      ["extracting 2/2 files", true],
      ["resolving calls…", true],
    ])
  })
})

describe("showDiffProgress", () => {
  it("names the side of each scan, both while both run, then the comparison", () => {
    const { terminal, drawn } = recordingTerminal()
    const show = showDiffProgress(terminal)

    const events: DiffProgress[] = [
      { kind: "scan", side: "head", progress: { phase: "discovering" } },
      { kind: "scan", side: "base", progress: { phase: "discovering" } },
      { kind: "scan", side: "head", progress: extracting(0, 3) },
      { kind: "scan", side: "base", progress: extracting(1, 4) },
      { kind: "scanned", side: "head" },
      { kind: "scan", side: "base", progress: { phase: "resolving" } },
      { kind: "scanned", side: "base" },
      { kind: "comparing" },
    ]
    for (const event of events) show(event)

    expect(drawn).toEqual([
      ["head: discovering files…", true],
      ["base: discovering files… · head: discovering files…", true],
      ["base: discovering files… · head: extracting 0/3 files", true],
      ["base: extracting 1/4 files · head: extracting 0/3 files", true],
      ["base: resolving calls…", true],
      ["comparing…", true],
    ])
  })
})
