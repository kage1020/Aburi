import { spawnSync } from "node:child_process"
import { open, rm } from "node:fs/promises"
import { join } from "node:path"
import { commitAll, gitTestEnv, initRepository, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { EXIT, type ExitCode } from "../../src"
import { CLI_BIN, type OutputStream, requireBuiltBin, runBin } from "./bin"

const workspace = useScratchWorkspace("closed-reader")

const ONE = "export function one(): number { return 1 }\n"

requireBuiltBin()

beforeEach(async () => {
  await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
  await workspace.writeSource("aburi.json", '{"languages":["lang-typescript"]}\n')
  await workspace.writeSource(".gitignore", "out/\n")
  await workspace.writeSource("src/one.ts", ONE)
  // A recoverable parse error puts lines on stderr for every command, without moving its code.
  await workspace.writeSource("src/broken.ts", "export function broken(): number { return 1 + }\n")
  await initRepository(workspace.root)
  await commitAll(workspace.root, "c1")
  await workspace.writeSource("src/one.ts", `${ONE}export function two(): number { return 2 }\n`)
  await commitAll(workspace.root, "c2")
})

async function runFromScratch(argv: readonly string[], unread: OutputStream | null = null) {
  // `explain` answers from the IR an earlier run left, and then has no scan to report on.
  await rm(join(workspace.root, "out"), { recursive: true, force: true })
  return runBin(workspace.root, argv, gitTestEnv(workspace.root), unread)
}

describe("aburi, when the reader of stdout or stderr has gone", () => {
  it.each<[string, OutputStream, ExitCode]>([
    ["diff HEAD~1..HEAD", "stdout", EXIT.SUCCESS],
    ["diff HEAD~1..HEAD --fail-on added", "stdout", EXIT.GATE],
    ["explain o", "stdout", EXIT.INPUT_ERROR],
    ["diff HEAD~1..HEAD", "stderr", EXIT.SUCCESS],
    ["diff HEAD~1..HEAD --fail-on added", "stderr", EXIT.GATE],
    ["scan", "stderr", EXIT.SUCCESS],
  ])("`aburi %s` with nothing reading its %s exits %i and writes the other stream in full", async (command, unread, code) => {
    const argv = command.split(" ")
    const other: OutputStream = unread === "stdout" ? "stderr" : "stdout"

    const read = await runFromScratch(argv)
    expect(read.code).toBe(code)
    expect(read[unread], `the command writes to ${unread}`).not.toBe("")

    const unreadRun = await runFromScratch(argv, unread)
    expect(unreadRun.code).toBe(code)
    expect(unreadRun[other]).toBe(read[other])
  })

  it.runIf(process.platform === "linux")(
    "still exits 1 when stdout refuses a write for another reason",
    async () => {
      const full = await open("/dev/full", "w")
      try {
        const run = spawnSync(process.execPath, [CLI_BIN, "scan"], {
          cwd: workspace.root,
          env: gitTestEnv(workspace.root),
          stdio: ["ignore", full.fd, "pipe"],
          encoding: "utf8",
        })
        expect(run.status).toBe(EXIT.RUNTIME)
        expect(run.stderr).toContain("ENOSPC")
      } finally {
        await full.close()
      }
    },
  )
})
