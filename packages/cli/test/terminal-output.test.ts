import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, VOCAB_DISCOVERED_FILENAME } from "../src"
import { documentWith, symbolFor } from "./ir-documents"
import { runCliIn, screenOf, TerminalStream, withoutColour } from "./run-cli"
import { writeStubRepository, writeStubWorkspace } from "./stub-language"
import { writeConfig, writeFileAt, writeIRs, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("terminal-output")

const ERASE = "\r\u001b[2K"
const WARNING = "⚠ 1 file(s) had recoverable parse errors."
const YELLOW_WARNING = `\u001b[33m${WARNING}\u001b[39m`

/** The same run twice: once with stderr piped, once with stderr on a terminal. */
async function pipedAndOnTerminal(argv: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const piped = await runCliIn(workspace.root, argv, env)
  const terminal = await runCliIn(workspace.root, argv, env, new TerminalStream())
  return { piped, terminal }
}

describe("stderr on a terminal", () => {
  it("draws the scan's progress, writes each line above it, and leaves only those lines behind", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub", "warn.stub"])

    const { piped, terminal } = await pipedAndOnTerminal(["scan", "--format", "json"])

    expect(terminal.code).toBe(piped.code)
    expect(terminal.stdout).toBe(piped.stdout)
    for (const phase of [
      "discovering files…",
      "extracting 0/2 files",
      "extracting 2/2 files",
      "resolving calls…",
    ]) {
      expect(terminal.stderr).toContain(`${ERASE}${phase}`)
    }
    expect(terminal.stderr).toContain(`${ERASE}${YELLOW_WARNING}\n`)
    expect(terminal.stderr.endsWith(ERASE)).toBe(true)
    expect(screenOf(withoutColour(terminal.stderr))).toBe(piped.stderr)
    expect(piped.stderr).toContain(WARNING)
  })

  it("draws the progress of the rescan aburi explain runs, and erases it before the answer", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub"])

    const { piped, terminal } = await pipedAndOnTerminal([
      "explain",
      "ok_stub",
      "--debug-resolution",
    ])

    expect(terminal.code).toBe(EXIT.SUCCESS)
    expect(terminal.stdout).toBe(piped.stdout)
    expect(terminal.stderr).toContain(`${ERASE}extracting 1/1 files`)
    expect(screenOf(terminal.stderr)).toBe(piped.stderr)
  })

  it("names the side of each scan aburi diff runs, then the comparison", async () => {
    await writeStubRepository(workspace.root, {
      base: ["ok.stub"],
      head: ["ok.stub", "added.stub"],
    })

    const { piped, terminal } = await pipedAndOnTerminal(["diff", "main..HEAD", "--parallel-scans"])

    expect(terminal.code).toBe(EXIT.SUCCESS)
    expect(terminal.stdout).toBe(piped.stdout)
    expect(terminal.stderr).toContain(`${ERASE}base: discovering files…`)
    expect(terminal.stderr).toMatch(/head: extracting 2\/2 files/)
    expect(terminal.stderr).toContain(`${ERASE}comparing…`)
    expect(screenOf(terminal.stderr)).toBe(piped.stderr)
  })

  it("shows the comparison alone when aburi diff reads two IRs", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub"])
    expect((await runCliIn(workspace.root, ["scan", "--format", "json"])).code).toBe(EXIT.SUCCESS)
    const ir = resolve(workspace.root, "out", "aburi.ir.json")

    const { terminal } = await pipedAndOnTerminal(["diff", "--base", ir, "--head", ir])

    expect(terminal.stderr).toBe(`${ERASE}comparing…${ERASE}`)
  })
})

describe("colour", () => {
  it.each<[string, readonly string[], NodeJS.ProcessEnv, boolean]>([
    ["nothing set", ["scan"], {}, true],
    ["NO_COLOR", ["scan"], { NO_COLOR: "1" }, false],
    ["FORCE_COLOR over NO_COLOR", ["scan"], { NO_COLOR: "1", FORCE_COLOR: "1" }, true],
    ["FORCE_COLOR=0", ["scan"], { FORCE_COLOR: "0" }, false],
    ["--no-color over FORCE_COLOR", ["scan", "--no-color"], { FORCE_COLOR: "1" }, false],
    ["--no-color before the command", ["--no-color", "scan"], {}, false],
  ])(
    "follows %s on a terminal, the progress line drawn either way",
    async (_, argv, env, coloured) => {
      await writeStubWorkspace(workspace.root, ["warn.stub"])

      const { stderr } = await runCliIn(workspace.root, argv, env, new TerminalStream())

      expect(stderr.includes(YELLOW_WARNING)).toBe(coloured)
      expect(stderr).toContain(WARNING)
      expect(stderr).toContain(`${ERASE}discovering files…`)
    },
  )

  it("colours piped stderr under FORCE_COLOR, the same text once the colour is stripped", async () => {
    await writeStubWorkspace(workspace.root, ["warn.stub"])

    const plain = await runCliIn(workspace.root, ["scan"])
    const forced = await runCliIn(workspace.root, ["scan"], { FORCE_COLOR: "1" })

    expect(withoutColour(plain.stderr)).toBe(plain.stderr)
    expect(plain.stderr).not.toContain(ERASE)
    expect(forced.stderr).toContain(YELLOW_WARNING)
    expect(forced.stderr).not.toContain(ERASE)
    expect(withoutColour(forced.stderr)).toBe(plain.stderr)
    expect(forced.stdout).toBe(plain.stdout)
  })

  it("colours an error that ends the run red", async () => {
    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--format", "bogus"], {
      FORCE_COLOR: "1",
    })

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr.startsWith("\u001b[31merror: option '--format <format>' argument 'bogus'")).toBe(
      true,
    )
  })

  it("colours each line of a gate that trips red", async () => {
    const gone = symbolFor("ts:src/gone.ts#gone")
    const paths = await writeIRs(
      workspace.root,
      documentWith({ symbols: [gone] }),
      documentWith({ symbols: [] }),
    )

    const { code, stderr } = await runCliIn(
      workspace.root,
      ["diff", "--base", paths.base, "--head", paths.head, "--fail-on", "removed"],
      { FORCE_COLOR: "1" },
    )

    expect(code).toBe(EXIT.GATE)
    expect(stderr).toContain(
      "\u001b[31m--fail-on removed tripped (observed: 1 removed)\u001b[39m\n\u001b[31m  ts:src/gone.ts#gone\u001b[39m\n",
    )
  })
})

describe("CI mode", () => {
  it.each<[string, readonly string[], NodeJS.ProcessEnv]>([
    ["CI=true", ["scan"], { CI: "true" }],
    ["--ci after the command", ["scan", "--ci"], {}],
    ["--ci before it", ["--ci", "scan"], {}],
    ["TERM=dumb, which is no CI but takes neither", ["scan"], { TERM: "dumb" }],
  ])("draws no progress line and no colour under %s", async (_, argv, env) => {
    await writeStubWorkspace(workspace.root, ["ok.stub", "warn.stub"])

    const piped = await runCliIn(workspace.root, argv, env)
    const terminal = await runCliIn(workspace.root, argv, env, new TerminalStream())

    expect(terminal.stderr).toBe(piped.stderr)
    expect(terminal.stderr).toContain(WARNING)
    expect(terminal.stdout).toBe(piped.stdout)
    expect(terminal.code).toBe(piped.code)
  })

  it("colours under FORCE_COLOR still, with no progress line", async () => {
    await writeStubWorkspace(workspace.root, ["warn.stub"])

    const { stderr } = await runCliIn(
      workspace.root,
      ["scan", "--ci"],
      { FORCE_COLOR: "1" },
      new TerminalStream(),
    )

    expect(stderr).toContain(YELLOW_WARNING)
    expect(stderr).not.toContain(ERASE)
  })

  it("leaves the timestamp out of the discovered-vocabulary record under --ci", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub"])

    expect((await runCliIn(workspace.root, ["scan", "--discover", "--ci"])).code).toBe(EXIT.SUCCESS)

    const record = JSON.parse(
      await readFile(resolve(workspace.root, "out", VOCAB_DISCOVERED_FILENAME), "utf8"),
    ) as Record<string, unknown>
    expect(record).toEqual({ items: [] })
  })
})

describe("stack traces", () => {
  async function writeExplodingPlugin(): Promise<void> {
    await writePackageJson(workspace.root)
    await writeConfig(workspace.root, { languages: ["./exploding.mjs"] })
    await writeFileAt(workspace.root, "exploding.mjs", 'throw new Error("module exploded")\n')
  }

  it("follows an error that ends the run at exit 3 with its stack and its cause's at debug", async () => {
    await writeExplodingPlugin()

    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--log-level", "debug"])

    expect(code).toBe(EXIT.GATE)
    const lines = stderr.trimEnd().split("\n")
    expect(lines[0]).toMatch(/^Failed to import plugin "\.\/exploding\.mjs" .*: module exploded$/)
    expect(lines[1]).toMatch(/^\s+at /)
    const cause = lines.indexOf("caused by: Error: module exploded")
    expect(cause).toBeGreaterThan(1)
    expect(lines[cause + 1]).toMatch(/^\s+at .*exploding\.mjs/)
  })

  it.each<[string, readonly string[]]>([
    ["at the default level", ["scan"]],
    ["for an exit-2 error at debug", ["scan", "--format", "bogus", "--log-level", "debug"]],
  ])("writes the message alone %s", async (_, argv) => {
    await writeExplodingPlugin()

    const { stderr } = await runCliIn(workspace.root, argv)

    expect(stderr.trimEnd().split("\n")).toHaveLength(1)
    expect(stderr).not.toMatch(/^\s+at /m)
  })
})

describe("the global options", () => {
  it.each(["init", "scan", "diff", "explain"])(
    "lists --no-color and --ci in `aburi %s --help`",
    async (command) => {
      const { stdout } = await runCliIn(workspace.root, [command, "--help"])

      expect(stdout).toMatch(/Global Options:\n[\s\S]*--no-color[\s\S]*--ci/)
    },
  )

  it("writes no progress line for aburi init, whatever the terminal", async () => {
    await writePackageJson(workspace.root)
    const stderr = new TerminalStream()

    await runCliIn(workspace.root, ["init"], {}, stderr)

    expect(stderr.text()).not.toContain(ERASE)
  })
})
