import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, EXIT, type GitRunner, runDiff } from "../src"
import { parseRenameRecords } from "../src/commands/diff"
import { type FakeGitOptions, fakeGit, gitOutput } from "./fixtures"

/**
 * Refspec-mode diff drives the injected `GitRunner` so we can exercise the ref-spec form without a
 * real git repo: head validation, worktree cleanup, and rename-collection warnings.
 */

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-git-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runDiff refspec mode — head ref validation", () => {
  it("rejects a head ref that git cannot resolve (was silently falling through before)", async () => {
    let verifyCount = 0
    const { runner } = fakeGit({
      handlers: {
        "rev-parse --verify": () => {
          verifyCount++
          if (verifyCount === 1) return gitOutput("abc\n")
          throw Object.assign(new Error("unknown revision"), { code: 128 })
        },
      },
    })
    await expect(
      runDiff({
        cwd: scratch,
        refSpec: "main..bogus",
        git: runner,
        outputDir: resolve(scratch, "out"),
        warn: () => {},
      }),
    ).rejects.toBeInstanceOf(CliError)
    // At least one rev-parse call for base plus one for head must be recorded.
    expect(verifyCount).toBe(2)
  })
})

/**
 * A ref that does not resolve, and what the run says about it. `git rev-parse --verify` fails
 * the same way outside a repository, in one with no commits, and for a mistyped name, so the
 * diagnosis asks two more questions — and every *answer* is the reader's to act on (exit 2),
 * because `git fetch` is the wrong remedy for two of the three and a mistyped ref is bad input.
 * A question git refuses is not an answer: the run then ends at exit 1 with git's own report,
 * because whatever refused the ref is still refusing, and a guess would replace the one
 * precise sentence there is (dubious ownership, and its `safe.directory` remedy) with a wrong one.
 */
describe("CL30–CL32 — why a ref did not resolve", () => {
  const GIT_SAID = "fatal: Needed a single revision"
  const refused = (what: string) => () => {
    throw Object.assign(new Error(what), { code: 128 })
  }

  async function failure(handlers: FakeGitOptions["handlers"]): Promise<{
    error: CliError
    asked: string[]
  }> {
    const { runner, calls } = fakeGit({
      handlers: { "rev-parse --verify": refused(GIT_SAID), ...handlers },
    })
    const error = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: () => {},
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(CliError)
    return { error: error as CliError, asked: calls.map((c) => c.args.slice(0, 2).join(" ")) }
  }

  it("CL30 — says the directory is not a git repository, and does not suggest fetching", async () => {
    // git refuses the question and nothing git would open stands above `scratch` — which is
    // the pair that means "outside any repository", and the only one that does.
    const { error } = await failure({
      "rev-parse --is-inside-work-tree": refused("fatal: not a git repository"),
    })
    expect(error.code).toBe("input-error")
    expect(error.message).toContain("Base ref 'main' could not be resolved")
    expect(error.message).toContain(`${scratch} is not inside a git repository`)
    expect(error.message).toContain("--base/--head")
    expect(error.message).toContain(GIT_SAID)
    expect(error.message).not.toContain("git fetch")
  })

  it("passes git's own report on, at exit 1, when it refuses the question inside a repository", async () => {
    // A `.git` above the directory means the refusal was about that repository — dubious
    // ownership is the everyday case — and git's report names the remedy this run cannot.
    await mkdir(resolve(scratch, ".git"))
    const said = "fatal: detected dubious ownership in repository"
    const { error } = await failure({
      "rev-parse --verify": refused(said),
      "rev-parse --is-inside-work-tree": refused(said),
    })
    expect(error.code).toBe("runtime-error")
    expect(error.message).toContain("Base ref 'main' could not be resolved")
    expect(error.message).toContain(said)
    expect(error.message).not.toContain("is not inside a git repository")
    expect(error.message).not.toContain("git fetch")
  })

  it("names a git directory that is not a working tree", async () => {
    const { error } = await failure({
      "rev-parse --is-inside-work-tree": () => gitOutput("false\n"),
    })
    expect(error.code).toBe("input-error")
    expect(error.message).toContain("not a working tree")
    expect(error.message).toContain("--base/--head")
  })

  it("CL31 — says the repository has no commits, and does not suggest fetching", async () => {
    const { error } = await failure({ "rev-list --all": () => gitOutput("") })
    expect(error.code).toBe("input-error")
    expect(error.message).toContain("has no commits yet")
    expect(error.message).toContain(GIT_SAID)
    expect(error.message).not.toContain("git fetch")
  })

  it("does not call a ref misspelt when git would not say whether there are commits", async () => {
    const { error } = await failure({ "rev-list --all": refused("fatal: bad object HEAD") })
    expect(error.code).toBe("runtime-error")
    expect(error.message).not.toContain("no such revision")
    expect(error.message).not.toContain("has no commits")
    expect(error.message).toContain(GIT_SAID)
  })

  it("CL32 — calls a ref no revision answers to an input error, with the spelling to check", async () => {
    const { error } = await failure({})
    expect(error.code).toBe("input-error")
    expect(error.message).toContain("Base ref 'main' could not be resolved")
    expect(error.message).toContain("no such revision")
    expect(error.message).toContain("Check the spelling")
    expect(error.message).toContain(GIT_SAID)
    // The clone that follows this advice is refused by the shallow check anyway
    // (`assertNotShallow`), so deepening it is not the advice.
    expect(error.message).not.toContain("--deepen")
  })

  it("asks the diagnosing questions only after a ref has failed", async () => {
    // The happy path pays for no extra git calls: the two probes are absent from a run whose
    // refs both resolved, and present once one did not.
    const { runner, calls } = fakeGit({
      handlers: {
        "worktree add": () => {
          throw new Error("stop here")
        },
      },
    })
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: () => {},
    }).catch(() => {
      // The worktree refusal ends the run; the calls before it are what this asserts.
    })
    const asked = calls.map((c) => c.args.slice(0, 2).join(" "))
    // Positive first, so the two absences below cannot pass on a run that never reached git.
    expect(asked).toContain("rev-parse --verify")
    expect(asked).not.toContain("rev-parse --is-inside-work-tree")
    expect(asked).not.toContain("rev-list --all")

    const { asked: askedAfterFailure } = await failure({})
    expect(askedAfterFailure).toContain("rev-parse --is-inside-work-tree")
    expect(askedAfterFailure).toContain("rev-list --all")
  })

  it("names the head when it is the head that failed", async () => {
    const { error } = await failure({
      "rev-parse --verify": (args) =>
        args[2] === "HEAD" ? refused(GIT_SAID)() : gitOutput("abc\n"),
    })
    expect(error.message).toContain("Head ref 'HEAD' could not be resolved")
  })
})

describe("runDiff refspec mode — git executable missing", () => {
  it("reports a git-installation error, not a ref-not-found error", async () => {
    const runner: GitRunner = {
      async run() {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })
      },
    }
    await expect(
      runDiff({
        cwd: scratch,
        refSpec: "main..HEAD",
        git: runner,
        outputDir: resolve(scratch, "out"),
        warn: () => {},
      }),
    ).rejects.toThrow(/git executable not found in PATH/)
  })
})

describe("runDiff refspec mode — collectRenames failure warns", () => {
  it("does not silently return null when git diff fails", async () => {
    // Base + head verify succeed, shallow check returns false, worktree add succeeds,
    // but the rename collection fails. runDiff will still fail (the scan needs a real
    // workspace), so we snapshot the warn call before the raise.
    const warnCalls: string[] = []
    const { runner } = fakeGit({
      handlers: {
        "diff --find-renames": () => {
          throw new Error("no such ref pair")
        },
      },
    })
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnCalls.push(m),
    }).catch(() => {
      // The scan will fail because scratch is not a real workspace — that's expected.
    })
    expect(warnCalls.some((m) => m.includes("Failed to collect git renames"))).toBe(true)
  })
})

describe("collectRenames — NUL-separated records", () => {
  it("asks git for -z output, so paths arrive unquoted and unsplit", async () => {
    const { runner, calls } = fakeGit()
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: () => {},
    }).catch(() => {
      // Scan-in-worktree will fail — the invocation is what this asserts.
    })
    const renameCall = calls.find((c) => c.args.slice(0, 2).join(" ") === "diff --find-renames")
    expect(renameCall?.args).toContain("-z")
    expect(renameCall?.args).toContain("--name-status")
  })

  /** The renames, or `null` where the reader refused the stream — the position it reports has
   * its own test below, and repeating it in every case would bury what each one is about. */
  function renames(stdout: string): ReadonlyMap<string, string> | null {
    const parsed = parseRenameRecords(stdout)
    return parsed.ok ? parsed.renames : null
  }

  it("reads a plain rename", () => {
    expect(renames("R094\0src/a.ts\0src/b.ts\0")).toEqual(new Map([["src/a.ts", "src/b.ts"]]))
  })

  it("keeps a target path containing a space whole", () => {
    // Whitespace-splitting produced the bogus pair `src/a.ts -> src/a` here, so the stage-2
    // match missed and the move degraded to removed + added.
    expect(renames("R094\0src/a.ts\0src/a b.ts\0")).toEqual(new Map([["src/a.ts", "src/a b.ts"]]))
  })

  it("keeps a path containing a tab whole", () => {
    // The one character the tab-separated format could not represent at all.
    expect(renames("R094\0src/a\tb.ts\0src/c\td.ts\0")).toEqual(
      new Map([["src/a\tb.ts", "src/c\td.ts"]]),
    )
  })

  it("keeps a non-ASCII path whole, unquoted and unescaped", () => {
    expect(renames("R100\0src/日本語.ts\0src/請求 書.ts\0")).toEqual(
      new Map([["src/日本語.ts", "src/請求 書.ts"]]),
    )
  })

  it("normalizes paths to NFC, the form source.file is compared in", () => {
    // A decomposed path out of git (macOS with core.precomposeUnicode off) would otherwise
    // build a map whose keys no `sym.source.file` can equal.
    const decomposed = "src/請求.ts".normalize("NFD")
    const map = renames(`R100\0${decomposed}\0${decomposed}2\0`)
    expect([...(map ?? new Map()).keys()]).toEqual(["src/請求.ts".normalize("NFC")])
    expect(map?.get("src/請求.ts".normalize("NFC"))).toBe(`${"src/請求.ts".normalize("NFC")}2`)
  })

  it("returns an empty map for a diff that renamed nothing", () => {
    expect(renames("")).toEqual(new Map())
    expect(renames("M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0")).toEqual(new Map())
  })

  it("consumes a copy's second path, so records after it stay aligned", () => {
    // `C` carries a second path like `R` does, though it is a copy and never enters the map.
    // Skipping it on the status alone would read `src/c.ts` as the next status and pair the
    // wrong two files.
    expect(renames("C085\0src/a.ts\0src/b.ts\0R097\0src/c.ts\0src/d.ts\0")).toEqual(
      new Map([["src/c.ts", "src/d.ts"]]),
    )
  })

  it("reads renames mixed in among other statuses", () => {
    expect(
      renames("M\0src/keep.ts\0R061\0src/old name.ts\0src/new name.ts\0A\0src/added.ts\0"),
    ).toEqual(new Map([["src/old name.ts", "src/new name.ts"]]))
  })

  it("refuses a stream it cannot read rather than inventing pairs", () => {
    // Three ways the reader loses the record boundaries: a record missing a whole field, a
    // stream cut inside one — which would otherwise map a rename onto a chopped path — and a
    // first field that cannot be a status. A plausible-looking wrong rename is worse for the
    // match than no rename hint at all.
    expect(renames("R094\0src/a.ts\0")).toBeNull()
    expect(renames("R094\0src/a.ts\0src/b.t")).toBeNull()
    expect(renames("src/a.ts\0src/b.ts\0")).toBeNull()
  })

  it("says where it stopped reading, so the warning can name the field", () => {
    expect(parseRenameRecords("R094\0src/a.ts\0src/b.t")).toEqual({
      ok: false,
      index: 2,
      field: "src/b.t",
    })
    expect(parseRenameRecords("src/a.ts\0src/b.ts\0")).toEqual({
      ok: false,
      index: 0,
      field: "src/a.ts",
    })
  })

  it("warns and drops the hints when the record stream is unreadable", async () => {
    const warnCalls: string[] = []
    const { runner } = fakeGit({
      handlers: { "diff --find-renames": () => gitOutput("R094\0src/a.ts\0") },
    })
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnCalls.push(m),
    }).catch(() => {
      // The scan will fail because scratch is not a real workspace — that's expected.
    })
    const warning = warnCalls.find((m) => m.includes("could not read"))
    // Naming the refspec and the field is what makes the line reproducible from a CI log.
    expect(warning).toContain("main..HEAD")
    expect(warning).toContain('"R094"')
  })

  it("warns when git exits 0 having given up on rename detection", async () => {
    // Over `diff.renameLimit` git succeeds, says so on stderr, and reports every move as a
    // delete plus an add. The records parse; the only evidence is the stderr line.
    const warnCalls: string[] = []
    const { runner } = fakeGit({
      handlers: {
        "diff --find-renames": () =>
          gitOutput(
            "D\0src/a.ts\0A\0src/b.ts\0",
            "warning: exhaustive rename detection was skipped due to too many files.\n",
          ),
      },
    })
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnCalls.push(m),
    }).catch(() => {
      // The scan will fail because scratch is not a real workspace — that's expected.
    })
    const warning = warnCalls.find((m) => m.includes("git reported while collecting renames"))
    expect(warning).toContain("exhaustive rename detection was skipped")
    expect(warning).toContain("diff.renameLimit")
  })
})

describe("runDiff refspec mode — worktree cleanup runs on failure", () => {
  it("issues `worktree remove` even when scan fails", async () => {
    const { runner, calls } = fakeGit()
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: () => {},
    }).catch(() => {
      // Scan-in-worktree will fail — we only care about the cleanup call.
    })
    const cleanup = calls.find((c) => c.args.slice(0, 2).join(" ") === "worktree remove")
    expect(cleanup).toBeDefined()
  })

  it("does not remove a worktree that `worktree add` never created", async () => {
    // Cleanup used to run unconditionally, so a failing `add` reported itself first as
    // `⚠ git worktree cleanup failed … Consider running \`git worktree prune\`` — sending the
    // reader after git's bookkeeping, which was never written, ahead of the real error.
    const warnCalls: string[] = []
    const { runner, calls } = fakeGit({
      handlers: {
        "worktree add": () => Promise.reject(new Error("fatal: could not create work tree dir")),
        "worktree remove": () => Promise.reject(new Error("worktree remove must not be reached")),
      },
    })

    const thrown = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnCalls.push(m),
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect((thrown as Error).message).toMatch(/could not create work tree dir/)
    expect(calls.some((c) => c.args.slice(0, 2).join(" ") === "worktree remove")).toBe(false)
    expect(warnCalls.some((m) => m.includes("git worktree cleanup failed"))).toBe(false)
  })
})

describe("SUCCESS smoke — file-mode diff still resolves EXIT.SUCCESS", () => {
  it("returns EXIT.SUCCESS with no fail-on set", async () => {
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    const emptyIR = {
      $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
      generator: { name: "aburi", version: "0.0.0", plugins: [] },
      workspace: { root: ".", managers: [], languages: ["ts"] },
      components: [],
      symbols: [],
      dependencies: [],
      stats: {
        totalFiles: 0,
        parsedFiles: 0,
        keptSymbols: 0,
        droppedSymbols: 0,
        effectPropagation: {
          sccCount: 0,
          maxSccSize: 0,
          propagatedEffectCount: 0,
          symbolsWithPropagatedEffects: 0,
        },
      },
    }
    await writeFile(basePath, JSON.stringify(emptyIR), "utf8")
    await writeFile(headPath, JSON.stringify(emptyIR), "utf8")
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      outputDir: resolve(scratch, "out"),
    })
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })
})
