import { describe, expect, it } from "vitest"
import {
  createTerminal,
  PROGRESS_INTERVAL_MS,
  type TerminalMode,
  type TerminalSettings,
  terminalMode,
} from "../src/terminal"
import { MemStream, TerminalStream } from "./run-cli"

const ERASE = "\r\u001b[2K"
const YELLOW = (text: string) => `\u001b[33m${text}\u001b[39m`
const RED = (text: string) => `\u001b[31m${text}\u001b[39m`
const DIM = (text: string) => `\u001b[2m${text}\u001b[22m`

const PLAIN_TERMINAL: TerminalSettings = {
  env: { noColor: false, forceColor: null, dumbTerminal: false },
  ci: false,
  colourFlag: true,
  isTerminal: true,
}

function settings(overrides: {
  env?: Partial<TerminalSettings["env"]>
  ci?: boolean
  colourFlag?: boolean
  isTerminal?: boolean
}): TerminalSettings {
  return { ...PLAIN_TERMINAL, ...overrides, env: { ...PLAIN_TERMINAL.env, ...overrides.env } }
}

describe("terminalMode", () => {
  it.each<[string, Parameters<typeof settings>[0], TerminalMode]>([
    ["colours and draws progress on a terminal", {}, { colour: true, progress: true }],
    ["does neither off one", { isTerminal: false }, { colour: false, progress: false }],
    [
      "does neither on TERM=dumb",
      { env: { dumbTerminal: true } },
      { colour: false, progress: false },
    ],
    [
      "drops colour alone under NO_COLOR",
      { env: { noColor: true } },
      { colour: false, progress: true },
    ],
    ["does neither in CI mode", { ci: true }, { colour: false, progress: false }],
    [
      "colours off a terminal under FORCE_COLOR, with no progress line",
      { isTerminal: false, env: { forceColor: true } },
      { colour: true, progress: false },
    ],
    [
      "lets FORCE_COLOR win over NO_COLOR",
      { env: { forceColor: true, noColor: true } },
      { colour: true, progress: true },
    ],
    [
      "lets FORCE_COLOR win over CI mode, and still draws no progress line there",
      { ci: true, env: { forceColor: true } },
      { colour: true, progress: false },
    ],
    [
      "lets FORCE_COLOR=0 turn colour off on a terminal",
      { env: { forceColor: false } },
      { colour: false, progress: true },
    ],
    [
      "lets --no-color win over FORCE_COLOR, and leaves the progress line",
      { colourFlag: false, env: { forceColor: true } },
      { colour: false, progress: true },
    ],
  ])("%s", (_, overrides, expected) => {
    expect(terminalMode(settings(overrides))).toEqual(expected)
  })
})

/** A terminal on `stream` whose clock reads `clock.now`. */
function terminalOn(stream: MemStream, mode: TerminalMode) {
  const clock = { now: 0 }
  const terminal = createTerminal(stream, { mode: () => mode, now: () => clock.now })
  return { terminal, clock, written: () => stream.chunks }
}

const ON: TerminalMode = { colour: true, progress: true }
const OFF: TerminalMode = { colour: false, progress: false }
const OFF_COLOUR_ON_PROGRESS: TerminalMode = { colour: false, progress: true }

describe("createTerminal — lines", () => {
  it("colours each line of a message in its tone, leaving an empty one bare", () => {
    const { terminal, written } = terminalOn(new TerminalStream(), ON)

    terminal.say("⚠ two\n\n  lines", "warning")
    terminal.say("failed", "error")
    terminal.say("debug: a", "muted")
    terminal.say("plain")

    expect(written()).toEqual([
      `${YELLOW("⚠ two")}\n\n${YELLOW("  lines")}\n`,
      `${RED("failed")}\n`,
      `${DIM("debug: a")}\n`,
      "plain\n",
    ])
  })

  it("writes the same text without colour", () => {
    const { terminal, written } = terminalOn(new MemStream(), OFF)

    terminal.say("⚠ warned", "warning")

    expect(written()).toEqual(["⚠ warned\n"])
  })
})

describe("createTerminal — the progress line", () => {
  it("draws nothing when the mode has no progress line", () => {
    const { terminal, written } = terminalOn(new MemStream(), OFF)

    terminal.progress("extracting 1/2 files", true)
    terminal.endProgress()

    expect(written()).toEqual([])
  })

  it("redraws in place, at most once an interval unless told to at once", () => {
    const { terminal, clock, written } = terminalOn(new TerminalStream(), ON)

    terminal.progress("extracting 0/3 files", true)
    clock.now = PROGRESS_INTERVAL_MS - 1
    terminal.progress("extracting 1/3 files")
    clock.now = PROGRESS_INTERVAL_MS
    terminal.progress("extracting 2/3 files")
    clock.now += 1
    terminal.progress("resolving calls…", true)

    expect(written()).toEqual([
      `${ERASE}extracting 0/3 files`,
      `${ERASE}extracting 2/3 files`,
      `${ERASE}resolving calls…`,
    ])
  })

  it("writes a line above it and draws it again, with the latest text it was given", () => {
    const { terminal, written } = terminalOn(new TerminalStream(), OFF_COLOUR_ON_PROGRESS)

    terminal.progress("extracting 0/3 files", true)
    terminal.progress("extracting 1/3 files")
    terminal.say("⚠ warned", "warning")

    expect(written()).toEqual([
      `${ERASE}extracting 0/3 files`,
      `${ERASE}⚠ warned\n${ERASE}extracting 1/3 files`,
    ])
  })

  it("erases it once for good, and writes plain lines after that", () => {
    const { terminal, written } = terminalOn(new TerminalStream(), OFF_COLOUR_ON_PROGRESS)

    terminal.progress("resolving calls…", true)
    terminal.endProgress()
    terminal.endProgress()
    terminal.say("done")

    expect(written()).toEqual([`${ERASE}resolving calls…`, ERASE, "done\n"])
  })

  it("cuts a line wider than the terminal so that it never wraps", () => {
    const { terminal, written } = terminalOn(new TerminalStream(12), OFF_COLOUR_ON_PROGRESS)

    terminal.progress("extracting 412/5002 files", true)
    terminal.progress("short", true)
    terminal.progress("elevenchars", true)

    expect(written()).toEqual([`${ERASE}extracting…`, `${ERASE}short`, `${ERASE}elevenchars`])
  })
})
