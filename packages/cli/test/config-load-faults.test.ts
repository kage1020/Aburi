import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { ConfigError, type ConfigErrorCode } from "@aburi/config"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, classifyConfigError, EXIT, runCli } from "../src"
import { loadPinnedConfig, resolveConfig } from "../src/config-load"

/**
 * Every failure of the config load used to be reported as the config being malformed, which
 * `cli-spec.md` §9 spends exit 2 on. Two kinds of failure arrive there that are not: a file
 * that exists and cannot be read, which is IO, and Aburi's own invariants, which are bugs.
 * Sending a reader through `aburi.json` for either is the misdirection `classifyDiffError`
 * exists to avoid one file away.
 */

/** The codes that describe the file the reader wrote, or the path they named. */
const READER_FAULTS: ConfigErrorCode[] = [
  "config-not-found",
  "config-parse-failed",
  "config-invalid",
  "duplicate-component-id",
  "duplicate-hint-name",
  "reserved-namespace",
]

/** `value` is required exactly for the codes that name one offending string. */
function detailFor(code: ConfigErrorCode): ConstructorParameters<typeof ConfigError>[1] {
  switch (code) {
    case "duplicate-component-id":
    case "duplicate-hint-name":
    case "reserved-namespace":
      return { code, value: "x" }
    default:
      return { code }
  }
}

describe("classifyConfigError — ConfigError to exit code (cli-spec.md §9)", () => {
  for (const code of READER_FAULTS) {
    it(`reports ${code} as the reader's to fix`, () => {
      const cliError = classifyConfigError(new ConfigError(`boom: ${code}`, detailFor(code)))

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
    // reader sees before anything else on the line.
    expect(cliError.message).toContain("Failed to load Aburi config: ")
    expect(cliError.message).not.toContain("bug in Aburi")
  })

  it("keeps a path that names nothing on the reader's side", () => {
    // The one that decides whether `--config ./typo.json` is an argument mistake or an IO
    // failure. §9 lists "missing" under exit 2, and no permission is involved.
    const cliError = classifyConfigError(
      new ConfigError("No config file at /w/typo.json", { code: "config-not-found" }),
    )

    expect(cliError.code).toBe("config-error")
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

  it("starts the report instruction on its own line", () => {
    // Nothing that reaches here ends in punctuation, so run-on is the ordinary case and the
    // instruction would be buried in the middle of whatever was thrown.
    const cliError = classifyConfigError(new TypeError("x.map is not a function"))

    expect(cliError.message).toContain("x.map is not a function\nThis is a bug in Aburi")
  })

  it("carries the thrown value as the cause whatever it was", () => {
    const thrown = new Error("ajv invariant violation")

    expect(classifyConfigError(thrown).cause).toBe(thrown)
  })

  it("keeps what a code it has no arm for said, rather than throwing it away", () => {
    // `@aburi/config` and `@aburi/cli` version independently, so a compiled switch can meet a
    // code it never saw. The compile-time check cannot help an installed tree, and discarding
    // the message would leave the reader with nothing about their own config.
    const cause = new ConfigError("Config at /w/aburi.json extends a ref that does not resolve", {
      code: "config-extends-unresolved",
    } as unknown as ConstructorParameters<typeof ConfigError>[1])

    const cliError = classifyConfigError(cause)

    expect(cliError.code).toBe("runtime-error")
    expect(cliError.message).toContain("extends a ref that does not resolve")
    expect(cliError.message).toContain("config-extends-unresolved")
    expect(cliError.cause).toBe(cause)
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

  interface Run {
    exitCode: number
    stderr: string
  }

  async function run(...argv: string[]): Promise<Run> {
    const captured = { text: "" }
    const sink = (target: { text: string } | null) =>
      ({
        write(chunk: string): boolean {
          if (target !== null) target.text += chunk
          return true
        },
      }) as unknown as NodeJS.WritableStream
    const exitCode = await runCli({
      argv,
      cwd: workRoot,
      stdout: sink(null),
      stderr: sink(captured),
    })
    return { exitCode, stderr: captured.text }
  }

  it("exits with a runtime failure for a config it cannot read, and says which phase", async () => {
    // A directory of that name: `access(F_OK)` finds it, so discovery hands it on, and the
    // read fails with EISDIR. EACCES would say the same thing on POSIX and cannot be set up
    // on Windows.
    await mkdir(resolve(workRoot, "aburi.json"))

    const { exitCode, stderr } = await run("scan")

    expect(exitCode).toBe(EXIT.RUNTIME)
    // Asserted on the stream rather than on the thrown value, because the raw `ConfigError`
    // would reach the same exit code through the generic handler — the prefix is what says
    // the classification ran at all.
    expect(stderr).toContain("Failed to load Aburi config: ")
    expect(stderr).not.toContain("bug in Aburi")
  })

  it("still exits with an input error for a config that is malformed", async () => {
    await writeFile(resolve(workRoot, "aburi.json"), "{ not json", "utf8")

    const { exitCode, stderr } = await run("scan")

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain("Failed to load Aburi config: ")
  })

  it("exits with an input error for a --config path that names nothing", async () => {
    const { exitCode, stderr } = await run("scan", "--config", "./typo.json")

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain("No config file at ")
  })
})

describe("resolveConfig — what the caller catches", () => {
  let workRoot = ""

  beforeEach(async () => {
    workRoot = await mkdtemp(resolve(tmpdir(), "aburi-config-faults-"))
  })

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true })
  })

  it("hands back a CliError already carrying its exit code", async () => {
    await mkdir(resolve(workRoot, "aburi.json"))

    const thrown = await resolveConfig(workRoot, undefined).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("runtime-error")
    expect((thrown as Error).message).toContain("Failed to load Aburi config: ")
  })
})

describe("loadPinnedConfig — the invariant the type only states", () => {
  let workRoot = ""

  beforeEach(async () => {
    workRoot = await mkdtemp(resolve(tmpdir(), "aburi-pinned-config-"))
  })

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true })
  })

  it("refuses a relative path rather than resolving it against the process cwd", async () => {
    // A pinned config's whole contract is that the answer no longer depends on where the
    // process is standing. `readConfigFile` calls `readFile` with the string it is handed, so
    // a relative path would quietly re-acquire that dependence — and then ride
    // `LoadedConfig.source` into `ScanReport.configSource`, where every consumer compares it
    // against an absolute workspace root.
    const thrown = await loadPinnedConfig({ kind: "file", path: "./aburi.json" }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as Error).message).toContain("is not absolute")
    expect((thrown as Error).message).toContain("Internal error while loading the Aburi config")
  })

  it("reads an absolute path whatever the working directory is", async () => {
    await writeFile(
      resolve(workRoot, "elsewhere.json"),
      JSON.stringify({ languages: ["lang-typescript"] }),
      "utf8",
    )

    const loaded = await loadPinnedConfig({
      kind: "file",
      path: resolve(workRoot, "elsewhere.json"),
    })

    expect(loaded.found).toBe(true)
    expect(loaded.source).toBe(resolve(workRoot, "elsewhere.json"))
  })
})
