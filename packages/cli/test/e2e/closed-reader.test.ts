import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { commitAll, gitTestEnv, initRepository, useScratchWorkspace } from "@aburi/test-support"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, type ExitCode } from "../../src"
import {
  linkedWorktrees,
  type OutputStream,
  removeWorktreeTempDirs,
  runBin,
  type StreamFault,
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

async function runFromScratch(argv: readonly string[], fault: StreamFault | null = null) {
  // `explain` answers from the IR an earlier run left, and then has no scan to report on.
  await rm(join(workspace.root, "out"), { recursive: true, force: true })
  const run = await runBin(workspace.root, argv, gitTestEnv(workspace.root), fault)
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
  ])(
    "`aburi %s` with nothing reading its %s exits %i, writes the other stream in full and cleans up",
    async (command, unread, code) => {
      const argv = command.split(" ")
      const other: OutputStream = unread === "stdout" ? "stderr" : "stdout"

      const read = await runFromScratch(argv)
      expect(read.code).toBe(code)
      expect(read[unread], `the command writes to ${unread}`).not.toBe("")

      const unreadRun = await runFromScratch(argv, { stream: unread, kind: "unread" })
      expect(unreadRun.code, unreadRun[other]).toBe(code)
      expect(unreadRun[other]).toBe(read[other])
      expect(unreadRun.written).toEqual(read.written)
      expect(linkedWorktrees(workspace.root)).toEqual([])
      expect(await worktreeTempDirs(workspace.root)).toEqual([])
    },
  )
})

describe("aburi, when stdout or stderr refuses a write", () => {
  it.each<[string, OutputStream]>([
    ["scan", "stdout"],
    ["scan", "stderr"],
    ["diff HEAD~1..HEAD", "stdout"],
    ["diff HEAD~1..HEAD", "stderr"],
    ["diff HEAD~1..HEAD --fail-on added", "stdout"],
    ["diff HEAD~1..HEAD --fail-on added", "stderr"],
  ])(
    "`aburi %s` whose %s refuses writes runs to its end, exits 1 and names the stream on the other",
    async (command, refused) => {
      const argv = command.split(" ")
      const other: OutputStream = refused === "stdout" ? "stderr" : "stdout"

      const read = await runFromScratch(argv)
      expect(read[refused], `the command writes to ${refused}`).not.toBe("")

      const refusedRun = await runFromScratch(argv, { stream: refused, kind: "refused" })
      expect(refusedRun.code, refusedRun[other]).toBe(EXIT.RUNTIME)
      expect(refusedRun[other]).toBe(`${read[other]}aburi: could not write to ${refused}: EBADF\n`)
      expect(refusedRun.written).toEqual(read.written)
      expect(linkedWorktrees(workspace.root)).toEqual([])
      expect(await worktreeTempDirs(workspace.root)).toEqual([])
    },
  )
})
