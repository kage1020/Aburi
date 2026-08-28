import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { ConfigError, type ConfigErrorCode } from "@aburi/config"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, classifyConfigError, EXIT, runCli } from "../src"

/**
 * Every failure of the config load used to be reported as the config being malformed, which
 * `cli-spec.md` §9 spends exit 2 on. Two kinds of failure arrive there that are not: a file
 * that exists and cannot be read, which is IO, and Aburi's own invariants, which are bugs.
 * Sending a reader through `aburi.json` for either is the misdirection `classifyDiffError`
 * exists to avoid one file away.
 */

const CONTENT_FAULTS: ConfigErrorCode[] = [
  "config-parse-failed",
  "config-invalid",
  "duplicate-component-id",
  "duplicate-hint-name",
  "reserved-namespace",
]

describe("classifyConfigError — ConfigError to exit code (cli-spec.md §9)", () => {
  for (const code of CONTENT_FAULTS) {
    it(`reports ${code} as the config's fault`, () => {
      const detail =
        code === "config-parse-failed" || code === "config-invalid" || code === "config-read-failed"
          ? ({ code } as const)
          : ({ code, value: "x" } as const)
      const cliError = classifyConfigError(new ConfigError(`boom: ${code}`, detail))

      expect(cliError.code).toBe("config-error")
      expect(cliError.message).toContain("Failed to load Aburi config: ")
      expect(cliError.message).toContain(`boom: ${code}`)
    })
  }

  it("reports a config that cannot be read as the machine's fault", () => {
    // §9 keeps exit 1 for IO. A config that is there and unreadable is not a malformed one,
    // and the remedy is a permission or a mount rather than an edit.
    const cause = new ConfigError("Failed to read config at /w/aburi.json (EACCES)", {
      code: "config-read-failed",
    })

    const cliError = classifyConfigError(cause)

    expect(cliError.code).toBe("runtime-error")
    // The same prefix as every other arm: it names the phase that failed, which is what a
    // reader — and `aburi diff`, deciding whether its own run got that far — reads it for.
    expect(cliError.message).toContain("Failed to load Aburi config: ")
    expect(cliError.message).not.toContain("bug in Aburi")
  })
})

describe("classifyConfigError — what is not a ConfigError at all", () => {
  /**
   * `formatAjvErrors` throws a bare `Error` when ajv reports failure with no errors, and its
   * own docblock says that means ajv is in an unexpected state rather than the user being
   * wrong. It reached the reader as `Failed to load Aburi config: ajv invariant violation…`
   * on exit 2, which is a sentence about their file.
   */
  const NOT_THE_CONFIG: [string, unknown][] = [
    ["an invariant Aburi broke", new Error("ajv invariant violation: validate returned false")],
    ["a shape nothing validated", new TypeError("x.map is not a function")],
    ["a string thrown by something", "boom"],
  ]

  for (const [label, thrown] of NOT_THE_CONFIG) {
    it(`reports ${label} as Aburi's own`, () => {
      const cliError = classifyConfigError(thrown)

      expect(cliError.code).toBe("runtime-error")
      expect(cliError.message).toContain("Internal error while loading the Aburi config")
      expect(cliError.message).toContain("This is a bug in Aburi, not in your configuration")
      expect(cliError.message).toContain("https://github.com/kage1020/Aburi/issues")
    })
  }

  it("carries the thrown value as the cause whatever it was", () => {
    const thrown = new Error("ajv invariant violation")

    expect(classifyConfigError(thrown).cause).toBe(thrown)
  })
})

describe("the exit code a command actually leaves with", () => {
  let workRoot = ""

  beforeEach(async () => {
    workRoot = await mkdtemp(resolve(tmpdir(), "aburi-config-faults-"))
  })

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true })
  })

  async function run(...argv: string[]): Promise<number> {
    const sink = {
      write(): boolean {
        return true
      },
    } as unknown as NodeJS.WritableStream
    return runCli({ argv, cwd: workRoot, stdout: sink, stderr: sink })
  }

  it("exits with a runtime failure for a config it cannot read", async () => {
    // A directory of that name: `access(F_OK)` finds it, so discovery hands it on, and the
    // read fails with EISDIR. EACCES would say the same thing on POSIX and cannot be set up
    // on Windows.
    await mkdir(resolve(workRoot, "aburi.json"))

    expect(await run("scan")).toBe(EXIT.RUNTIME)
  })

  it("still exits with an input error for a config that is malformed", async () => {
    await writeFile(resolve(workRoot, "aburi.json"), "{ not json", "utf8")

    expect(await run("scan")).toBe(EXIT.INPUT_ERROR)
  })

  it("says which phase failed either way", async () => {
    await mkdir(resolve(workRoot, "aburi.json"))
    const thrown = await import("../src/config-load").then((module) =>
      module.resolveConfig(workRoot, undefined).then(
        () => null,
        (error: unknown) => error,
      ),
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("runtime-error")
    expect((thrown as Error).message).toContain("Failed to load Aburi config: ")
  })
})
