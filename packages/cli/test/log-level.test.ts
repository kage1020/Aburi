import { useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT } from "../src"
import { runCliIn } from "./run-cli"
import { writeStubRepository } from "./stub-language"

const workspace = useScratchWorkspace("log-level")

const LOGGER_LINE = /^(debug|info|warn|error): /

const skipped = (file: string): string =>
  `warn: Skipped ${file}: parse reported a non-recoverable error at 12:4 — unterminated string\n`
const extracted = (file: string): string => `debug: scan/pipeline: ${file} produced 1 symbols\n`

async function loggedBy(argv: readonly string[], env: NodeJS.ProcessEnv) {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const { code } = await runCliIn(workspace.root, argv, env)
    const lines = write.mock.calls.map(([chunk]) => String(chunk))
    return { code, lines: lines.filter((line) => LOGGER_LINE.test(line)) }
  } finally {
    write.mockRestore()
  }
}

type Shows = "warn" | "debug" | "none"

interface Logged {
  argv: readonly string[]
  atWarn: readonly string[]
  atDebug: readonly string[]
}

describe.each<[string, string, Logged]>([
  [
    "scan",
    "its scan",
    {
      argv: ["scan"],
      atWarn: [skipped("head-bad.stub")],
      atDebug: [skipped("head-bad.stub"), extracted("ok.stub")],
    },
  ],
  [
    "diff",
    "both of its scans",
    {
      argv: ["diff", "main..HEAD"],
      atWarn: [skipped("base-bad.stub"), skipped("head-bad.stub")],
      atDebug: [
        skipped("base-bad.stub"),
        extracted("ok.stub"),
        skipped("head-bad.stub"),
        extracted("ok.stub"),
      ],
    },
  ],
  [
    "explain",
    "the scan it runs with no IR on disk",
    {
      argv: ["explain", "ok_stub"],
      atWarn: [skipped("head-bad.stub")],
      atDebug: [skipped("head-bad.stub"), extracted("ok.stub")],
    },
  ],
])("aburi %s — the per-file log of %s", (_, __, command) => {
  beforeEach(async () => {
    await writeStubRepository(workspace.root, {
      base: ["base-bad.stub", "ok.stub"],
      head: ["head-bad.stub", "ok.stub"],
    })
  })

  it.each<
    [
      title: string,
      before: readonly string[],
      after: readonly string[],
      env: NodeJS.ProcessEnv,
      shows: Shows,
    ]
  >([
    ["keeps warn and above with nothing set", [], [], {}, "warn"],
    ["prints none of it at ABURI_LOG_LEVEL=error", [], [], { ABURI_LOG_LEVEL: "error" }, "none"],
    [
      "adds the debug lines at ABURI_LOG_LEVEL=debug",
      [],
      [],
      { ABURI_LOG_LEVEL: "debug" },
      "debug",
    ],
    [
      "takes --log-level debug over ABURI_LOG_LEVEL=error",
      [],
      ["--log-level", "debug"],
      { ABURI_LOG_LEVEL: "error" },
      "debug",
    ],
    [
      "takes --log-level error, written before the command, over ABURI_LOG_LEVEL=debug",
      ["--log-level", "error"],
      [],
      { ABURI_LOG_LEVEL: "debug" },
      "none",
    ],
    [
      "takes --log-level info, which shows the same as the default",
      [],
      ["--log-level", "info"],
      {},
      "warn",
    ],
    ["ignores an ABURI_LOG_LEVEL it does not know", [], [], { ABURI_LOG_LEVEL: "loud" }, "warn"],
  ])("%s", async (_, before, after, env, shows) => {
    const lines = { warn: command.atWarn, debug: command.atDebug, none: [] }[shows]
    expect(await loggedBy([...before, ...command.argv, ...after], env)).toEqual({
      code: EXIT.SUCCESS,
      lines,
    })
  })
})

describe("aburi --log-level", () => {
  it("refuses a level it does not know at exit 2, naming the four it does", async () => {
    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--log-level", "loud"])
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain("--log-level must be one of: debug | info | warn | error")
  })

  it("is accepted by aburi init, which has no per-file log", async () => {
    const { code } = await runCliIn(workspace.root, ["init", "--log-level", "debug"])
    expect(code).toBe(EXIT.SUCCESS)
  })

  it.each([
    "init",
    "scan",
    "diff",
    "explain",
  ])("is listed among the global options of `aburi %s --help`", async (command) => {
    const { code, stdout } = await runCliIn(workspace.root, [command, "--help"])
    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout).toMatch(/Global Options:\n[\s\S]*--log-level <level>/)
  })
})
