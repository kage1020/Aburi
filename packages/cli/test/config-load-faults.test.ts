import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { ConfigError, type ConfigErrorCode } from "@aburi/config"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, classifyConfigError, EXIT, runCli } from "../src"
import { loadPinnedConfig, resolveConfig } from "../src/config-load"

const READER_FAULTS: ConfigErrorCode[] = [
  "config-not-found",
  "config-parse-failed",
  "config-invalid",
  "duplicate-component-id",
  "duplicate-hint-name",
  "reserved-namespace",
]

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

describe("classifyConfigError — ConfigError to exit code (cli-spec.md)", () => {
  for (const code of READER_FAULTS) {
    it(`reports ${code} as the reader's to fix`, () => {
      const cliError = classifyConfigError(new ConfigError(`boom: ${code}`, detailFor(code)))

      expect(cliError.code).toBe("config-error")
      expect(cliError.message).toContain("Failed to load Aburi config: ")
      expect(cliError.message).toContain(`boom: ${code}`)
    })
  }

  it("reports a config that cannot be read as the machine's fault", () => {
    const cause = new ConfigError("Failed to read config at /w/aburi.json (EACCES)", {
      code: "config-read-failed",
    })

    const cliError = classifyConfigError(cause)

    expect(cliError.code).toBe("runtime-error")
    expect(cliError.message).toContain("Failed to load Aburi config: ")
    expect(cliError.message).not.toContain("bug in Aburi")
  })

  it("keeps a path that names nothing on the reader's side", () => {
    const cliError = classifyConfigError(
      new ConfigError("No config file at /w/typo.json", { code: "config-not-found" }),
    )

    expect(cliError.code).toBe("config-error")
  })
})

describe("classifyConfigError — what is not a ConfigError at all", () => {
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
    const cliError = classifyConfigError(new TypeError("x.map is not a function"))

    expect(cliError.message).toContain("x.map is not a function\nThis is a bug in Aburi")
  })

  it("carries the thrown value as the cause whatever it was", () => {
    const thrown = new Error("ajv invariant violation")

    expect(classifyConfigError(thrown).cause).toBe(thrown)
  })

  it("keeps what a code it has no arm for said, rather than throwing it away", () => {
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
    await mkdir(resolve(workRoot, "aburi.json"))

    const { exitCode, stderr } = await run("scan")

    expect(exitCode).toBe(EXIT.RUNTIME)
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
