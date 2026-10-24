import { spawnSync } from "node:child_process"
import { open, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { commitAll, gitTestEnv, initRepository, useScratchWorkspace } from "@aburi/test-support"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, type ExitCode } from "../../src"
import {
  CLI_BIN,
  linkedWorktrees,
  type OutputStream,
  removeWorktreeTempDirs,
  runBin,
  useBuiltBin,
  worktreeTempDirs,
} from "./bin"

const workspace = useScratchWorkspace("closed-reader")

const ONE = "export function one(): number { return 1 }\n"

useBuiltBin()

beforeEach(async () => {
  await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
  await workspace.writeSource("aburi.json", '{"languages":["lang-typescript"]}\n')
  await workspace.writeSource(".gitignore", "out/\n")
  await workspace.writeSource("src/one.ts", ONE)
  // A recoverable parse error puts lines on stderr for each command below, without moving its code.
  await workspace.writeSource("src/broken.ts", "export function broken(): number { return 1 + }\n")
  await initRepository(workspace.root)
  await commitAll(workspace.root, "c1")
  await workspace.writeSource("src/one.ts", `${ONE}export function two(): number { return 2 }\n`)
  await commitAll(workspace.root, "c2")
})

afterEach(async () => {
  await removeWorktreeTempDirs(workspace.root)
})

async function runFromScratch(argv: readonly string[], unread: OutputStream | null = null) {
  // `explain` answers from the IR an earlier run left, and then has no scan to report on.
  await rm(join(workspace.root, "out"), { recursive: true, force: true })
  const run = await runBin(workspace.root, argv, gitTestEnv(workspace.root), unread)
  const written = await readdir(join(workspace.root, "out"), { recursive: true })
  return { ...run, written: written.sort() }
}

describe("aburi, when the reader of stdout or stderr has gone", () => {
  it.each<[string, OutputStream, ExitCode]>([
    ["diff HEAD~1..HEAD", "stdout", EXIT.SUCCESS],
    ["diff HEAD~1..HEAD --fail-on added", "stdout", EXIT.GATE],
    ["explain o", "stdout", EXIT.INPUT_ERROR],
    ["diff HEAD~1..HEAD", "stderr", EXIT.SUCCESS],
    ["diff HEAD~1..HEAD --fail-on added", "stderr", EXIT.GATE],
    ["scan", "stderr", EXIT.SUCCESS],
  ])("`aburi %s` with nothing reading its %s exits %i, writes the other stream in full and cleans up", async (command, unread, code) => {
    const argv = command.split(" ")
    const other: OutputStream = unread === "stdout" ? "stderr" : "stdout"

    const read = await runFromScratch(argv)
    expect(read.code).toBe(code)
    expect(read[unread], `the command writes to ${unread}`).not.toBe("")

    const unreadRun = await runFromScratch(argv, unread)
    expect(unreadRun.code, unreadRun[other]).toBe(code)
    expect(unreadRun[other]).toBe(read[other])
    expect(unreadRun.written).toEqual(read.written)
    expect(linkedWorktrees(workspace.root)).toEqual([])
    expect(await worktreeTempDirs(workspace.root)).toEqual([])
  })

  it("still exits 1, with Node's report of the error, when stdout refuses a write for another reason", async () => {
    // A descriptor opened only for reading refuses every write, with EBADF on every OS.
    const readOnly = await open(join(workspace.root, "package.json"), "r")
    try {
      const run = spawnSync(process.execPath, [CLI_BIN, "scan"], {
        cwd: workspace.root,
        env: gitTestEnv(workspace.root),
        stdio: ["ignore", readOnly.fd, "pipe"],
        encoding: "utf8",
      })
      expect(run.status).toBe(EXIT.RUNTIME)
      expect(run.stderr).toContain("EBADF")
    } finally {
      await readOnly.close()
    }
  })
})
