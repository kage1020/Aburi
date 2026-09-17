import { execFile } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"
import { ABURI_COMMENT_BODY_MAX_BYTES } from "../src/comment"

const execFileAsync = promisify(execFile)

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "resolve-max-bytes.mjs",
)

/**
 * Run as a process against a real CLI, because that is what `action.yml` does with it: stdout is
 * captured into `budget`, stderr becomes annotations in the job log, and a non-zero exit fails
 * the step. A unit test of the same decision would prove none of those three.
 */
interface RunResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

const workspaces: string[] = []

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fakeCli(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aburi-fake-cli-"))
  workspaces.push(dir)
  const path = join(dir, "cli.mjs")
  await writeFile(path, body)
  await chmod(path, 0o755)
  return path
}

/** A CLI whose `diff --help` lists the flag: what a current @aburi/cli answers. */
function currentCli(): Promise<string> {
  return fakeCli(
    `process.stdout.write("Usage: aburi diff\\n  --fail-on <spec>\\n  --max-bytes <n>  cap diff.md\\n")\n`,
  )
}

/** A CLI from before the flag existed — the arrangement `version` pinning makes routine. */
function olderCli(): Promise<string> {
  return fakeCli(`process.stdout.write("Usage: aburi diff\\n  --fail-on <spec>\\n")\n`)
}

/** A CLI that cannot run at all: a registry failure, a bad `version`, a crash at startup. */
function brokenCli(): Promise<string> {
  return fakeCli(`process.stderr.write("ERR_PNPM_NO_MATCHING_VERSION\\n")\nprocess.exit(1)\n`)
}

async function run(
  env: Record<string, string>,
  runner: readonly string[] = [],
): Promise<RunResult> {
  const spawnEnv: Record<string, string> = { PATH: process.env.PATH ?? "", ...env }
  try {
    const done = await execFileAsync(process.execPath, [SCRIPT, ...runner], { env: spawnEnv })
    return { status: 0, stdout: done.stdout, stderr: done.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return {
      status: failure.code ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    }
  }
}

describe("resolve-max-bytes.mjs", () => {
  it("defaults to what a comment body can hold, once the CLI says it can take it", async () => {
    const cli = await currentCli()
    const result = await run({ MAX_BYTES: "", FORMAT: "both" }, [process.execPath, cli])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(String(ABURI_COMMENT_BODY_MAX_BYTES))
    expect(result.stderr).toBe("")
  })

  it("passes a caller's own budget through", async () => {
    const cli = await currentCli()
    const result = await run({ MAX_BYTES: "4000", FORMAT: "both" }, [process.execPath, cli])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("4000")
  })

  it("takes `0` as no cap, without probing anything", async () => {
    // No runner at all: reaching the probe would be an error, which is the assertion.
    const result = await run({ MAX_BYTES: "0", FORMAT: "both" })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
  })

  it("caps nothing under `format: json`, which writes no Markdown", async () => {
    const result = await run({ MAX_BYTES: "", FORMAT: "json" })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
  })

  it("is exit 2 on a value that is not a byte count", async () => {
    for (const value of ["64kb", "-1", "1.5", " 4000", "00"]) {
      const result = await run({ MAX_BYTES: value, FORMAT: "both" }, [process.execPath])
      expect(result.status, `accepted ${JSON.stringify(value)}`).toBe(2)
      expect(result.stderr).toContain("::error::")
      expect(result.stderr).toContain("max-bytes must be a non-negative integer")
      expect(result.stdout).toBe("")
    }
  })

  it("renders uncapped, with a warning naming both upgrade routes, against an older CLI", async () => {
    const cli = await olderCli()
    const result = await run({ MAX_BYTES: "", FORMAT: "both" }, [process.execPath, cli])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("::warning::")
    expect(result.stderr).toContain("has no --max-bytes")
    // `version` is meaningless under `cli: workspace`, where the CLI is the caller's own.
    expect(result.stderr).toContain("'version' input")
    expect(result.stderr).toContain("cli: workspace")
  })

  it("does not blame the CLI for a probe that could not run", async () => {
    // A registry outage and a missing flag are not the same finding. Saying the second when the
    // first happened is how a green job under `comment: false` ends up publishing an oversized
    // artefact with a log that explains it wrongly.
    const cli = await brokenCli()
    const result = await run({ MAX_BYTES: "", FORMAT: "both" }, [process.execPath, cli])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Could not ask the CLI whether it supports --max-bytes")
    expect(result.stderr).toContain("ERR_PNPM_NO_MATCHING_VERSION")
    expect(result.stderr).not.toContain("has no --max-bytes")
  })

  it("matches the flag however long the help text is", async () => {
    // The `grep -q` pipeline this replaces inverted its own result once the writer outran the
    // pipe buffer: `grep` exits at the first match, the writer takes SIGPIPE, and `pipefail`
    // reports the successful match as a failure.
    const cli = await fakeCli(
      `process.stdout.write("  --max-bytes <n>\\n" + "x".repeat(2_000_000) + "\\n")\n`,
    )
    const result = await run({ MAX_BYTES: "", FORMAT: "both" }, [process.execPath, cli])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(String(ABURI_COMMENT_BODY_MAX_BYTES))
  })

  it("finds the flag in help text a CLI writes to stderr", async () => {
    const cli = await fakeCli(`process.stderr.write("  --max-bytes <n>  cap diff.md\\n")\n`)
    const result = await run({ MAX_BYTES: "", FORMAT: "both" }, [process.execPath, cli])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(String(ABURI_COMMENT_BODY_MAX_BYTES))
  })
})
