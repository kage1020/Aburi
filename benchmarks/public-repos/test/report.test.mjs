import { describe, expect, it } from "vitest"
import {
  containsPath,
  countRecoverableParseErrors,
  parseArgs,
  resolveRepos,
  scanRunFault,
  scrubPaths,
  summariseScans,
} from "../report.mjs"

function measurement(overrides = {}) {
  return { wallMs: 1000, maxRssKb: 120_000, exitCode: 0, failure: null, ...overrides }
}

function run(overrides = {}) {
  return {
    irWritten: true,
    hash: "a",
    ...overrides,
    measurement: measurement(overrides.measurement),
  }
}

describe("summariseScans", () => {
  it("condemns the whole repository when any measured run failed", () => {
    const summary = summariseScans([
      run(),
      run({ measurement: { exitCode: 1 }, irWritten: false }),
      run(),
    ])
    expect(summary.failed).toBe("scan")
    expect(summary.fault).toBe("run 2 of 3: exit 1")
  })

  it("keeps a gate exit, which is a completed run, as a measurement", () => {
    const summary = summariseScans([run({ measurement: { exitCode: 3 } })])
    expect(summary.failed).toBeUndefined()
    expect(summary.exitCode).toBe(3)
  })

  it("keeps every run's exit code and hash, not only one", () => {
    const summary = summariseScans([
      run({ measurement: { exitCode: 0 } }),
      run({ measurement: { exitCode: 3 }, hash: "b" }),
      run({ measurement: { exitCode: 0 } }),
    ])
    expect(summary.exitCodes).toEqual([0, 3, 0])
    expect(summary.irHashes).toEqual(["a", "b", "a"])
    expect(summary.deterministic).toBe(false)
  })

  it("leaves determinism unmeasured when a single run compared nothing", () => {
    expect(summariseScans([run()]).deterministic).toBeNull()
    expect(summariseScans([run(), run()]).deterministic).toBe(true)
    expect(summariseScans([run(), run({ hash: "b" })]).deterministic).toBe(false)
  })
})

describe("scanRunFault", () => {
  it("accepts a clean run, and a gate exit that still wrote an IR", () => {
    expect(scanRunFault(measurement(), true)).toBeNull()
    expect(scanRunFault(measurement({ exitCode: 3 }), true)).toBeNull()
  })

  it("rejects a run with no measurement, a runtime or input failure, and a missing IR", () => {
    expect(scanRunFault(measurement({ wallMs: null, failure: "killed" }), true)).toBe("killed")
    expect(scanRunFault(measurement({ exitCode: 1 }), true)).toBe("exit 1")
    expect(scanRunFault(measurement({ exitCode: 2 }), true)).toBe("exit 2")
    expect(scanRunFault(measurement(), false)).toBe("no IR was written")
  })
})

describe("scrubPaths", () => {
  it("removes the work directory and the base worktree from captured output", () => {
    const text =
      "⚠ Config /tmp/bench/zod/aburi.json sits below the workspace root /tmp/aburi-worktree-QBe6m9/base."
    expect(scrubPaths(text, "/tmp/bench")).toBe(
      "⚠ Config <work-dir>/zod/aburi.json sits below the workspace root <base-worktree>/base.",
    )
  })

  it("leaves output that names no absolute path alone", () => {
    expect(scrubPaths("⚠ 115 file(s) had recoverable parse errors.", "/tmp/bench")).toBe(
      "⚠ 115 file(s) had recoverable parse errors.",
    )
  })
})

describe("countRecoverableParseErrors", () => {
  it("reads the count the scan reported", () => {
    expect(countRecoverableParseErrors("⚠ 115 file(s) had recoverable parse errors.\n")).toBe(115)
  })

  it("is zero when the scan reported none", () => {
    expect(countRecoverableParseErrors("")).toBe(0)
    expect(countRecoverableParseErrors("⚠ 1 file(s) contributed no Symbols.\n")).toBe(0)
  })
})

describe("containsPath", () => {
  const root = "/home/user/Aburi"

  it("rejects a work directory inside the repository", () => {
    expect(containsPath(root, "/home/user/Aburi/bench", "linux")).toBe(true)
    expect(containsPath(root, root, "linux")).toBe(true)
  })

  it("permits a sibling whose name merely starts with the repository's", () => {
    expect(containsPath(root, "/home/user/Aburi-bench", "linux")).toBe(false)
    expect(containsPath(root, "/tmp/aburi-bench-work", "linux")).toBe(false)
  })

  it("rejects a path differing from the repository only in case, as Windows resolves it", () => {
    const root = String.raw`C:\Users\u\Aburi`
    expect(containsPath(root, String.raw`c:\users\u\aburi\bench`, "win32")).toBe(true)
    expect(containsPath(root, String.raw`C:\Users\u\Aburi-bench`, "win32")).toBe(false)
  })
})

describe("parseArgs", () => {
  it("rejects a run count that is not a positive whole number", () => {
    expect(() => parseArgs(["--runs", "abc"])).toThrow(/--runs/)
    expect(() => parseArgs(["--runs", "0"])).toThrow(/--runs/)
    expect(() => parseArgs(["--runs", "2.5"])).toThrow(/--runs/)
    expect(() => parseArgs(["--warmup", "-1"])).toThrow(/--warmup/)
  })

  it("rejects a flag whose value is missing, naming the flag", () => {
    expect(() => parseArgs(["--only"])).toThrow(/--only/)
    expect(() => parseArgs(["--work-dir"])).toThrow(/--work-dir/)
  })

  it("accepts the defaults and the flags the README documents", () => {
    expect(parseArgs([]).runs).toBe(3)
    expect(parseArgs(["--no-diff"]).diff).toBe(false)
    expect(parseArgs(["--only", "zod,nest"]).only).toEqual(["zod", "nest"])
  })
})

describe("resolveRepos", () => {
  const manifest = { repos: [{ id: "zod" }, { id: "nest" }] }

  it("rejects an id the manifest does not carry, rather than measuring the rest", () => {
    expect(() => resolveRepos(manifest, [" nest"])).toThrow(/ nest/)
    expect(() => resolveRepos(manifest, ["zod", "typo"])).toThrow(/typo/)
  })

  it("keeps the manifest's order rather than the order asked for", () => {
    expect(resolveRepos(manifest, ["nest", "zod"]).map((repo) => repo.id)).toEqual(["zod", "nest"])
    expect(resolveRepos(manifest, null)).toHaveLength(2)
  })
})
