import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { ConfigError, type ConfigErrorCode } from "@aburi/config"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CliError, classifyConfigError, EXIT } from "../src"
import { loadPinnedConfig } from "../src/config-load"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig } from "./workspace"

const workspace = useScratchWorkspace("config-load-faults")

function configError(code: ConfigErrorCode): ConfigError {
  switch (code) {
    case "duplicate-component-id":
    case "duplicate-hint-name":
    case "reserved-namespace":
      return new ConfigError(`boom: ${code}`, { code, value: "x" })
    default:
      return new ConfigError(`boom: ${code}`, { code })
  }
}

describe("classifyConfigError — a ConfigError onto the exit-code table", () => {
  it.each<ConfigErrorCode>([
    "config-not-found",
    "config-parse-failed",
    "config-invalid",
    "duplicate-component-id",
    "duplicate-hint-name",
    "reserved-namespace",
  ])("reports %s as the reader's to fix", (code) => {
    const cliError = classifyConfigError(configError(code))

    expect(cliError.code).toBe("config-error")
    expect(cliError.message).toBe(`Failed to load Aburi config: boom: ${code}`)
  })

  it("reports a config that cannot be read as the machine's fault", () => {
    const cliError = classifyConfigError(configError("config-read-failed"))

    expect(cliError.code).toBe("runtime-error")
    expect(cliError.message).toBe("Failed to load Aburi config: boom: config-read-failed")
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

describe("classifyConfigError — what is not a ConfigError at all", () => {
  it.each<[string, unknown]>([
    ["an invariant Aburi broke", new Error("ajv invariant violation: validate returned false")],
    ["a shape nothing validated", new TypeError("x.map is not a function")],
    ["a string thrown by something", "boom"],
  ])("reports %s as a bug in Aburi, carrying it as the cause", (_, thrown) => {
    const cliError = classifyConfigError(thrown)

    expect(cliError.code).toBe("runtime-error")
    expect(cliError.message).toContain("Internal error while loading the Aburi config")
    expect(cliError.message).toContain("This is a bug in Aburi, not in your configuration")
    expect(cliError.message).toContain("https://github.com/kage1020/Aburi/issues")
    expect(cliError.cause).toBe(thrown)
  })

  it("starts the report instruction on its own line", () => {
    const cliError = classifyConfigError(new TypeError("x.map is not a function"))

    expect(cliError.message).toContain("x.map is not a function\nThis is a bug in Aburi")
  })
})

describe("aburi scan — the exit code a config fault leaves with", () => {
  it.each([
    [
      "a config it cannot read, at exit 1",
      () => mkdir(resolve(workspace.root, "aburi.json")),
      [],
      EXIT.RUNTIME,
      "Failed to load Aburi config: ",
    ],
    [
      "a config that is malformed, at exit 2",
      () => workspace.writeSource("aburi.json", "{ not json"),
      [],
      EXIT.INPUT_ERROR,
      "Failed to load Aburi config: ",
    ],
    [
      "a --config path that names nothing, at exit 2",
      async () => {},
      ["--config", "./typo.json"],
      EXIT.INPUT_ERROR,
      "No config file at ",
    ],
  ])("reports %s", async (_, arrange, flags, exitCode, says) => {
    await arrange()

    const { code, stderr } = await runCliIn(workspace.root, ["scan", ...flags])

    expect(code).toBe(exitCode)
    expect(stderr).toContain(says)
    expect(stderr).not.toContain("bug in Aburi")
  })
})

describe("loadPinnedConfig", () => {
  it("refuses a relative path rather than resolving it against the process cwd", async () => {
    const error = await errorFrom(CliError, () =>
      loadPinnedConfig({ kind: "file", path: "./aburi.json" }),
    )

    expect(error.message).toContain("Internal error while loading the Aburi config")
    expect(error.message).toContain("is not absolute")
  })

  it("reads an absolute path whatever the working directory is", async () => {
    await writeConfig(workspace.root, TYPESCRIPT, "elsewhere.json")

    const loaded = await loadPinnedConfig({
      kind: "file",
      path: resolve(workspace.root, "elsewhere.json"),
    })

    expect(loaded).toMatchObject({ found: true, source: resolve(workspace.root, "elsewhere.json") })
  })
})
