import { join } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { ABURI_COMMENT_BODY_MAX_BYTES } from "../src/comment"
import { runScript } from "./fixtures/scripts"

const scratch = useScratchWorkspace("resolve-max-bytes")

/** A CLI runner (`node <script>`) whose `diff --help` runs `body`. */
async function fakeCli(body: string): Promise<string[]> {
  await scratch.writeSource("cli.mjs", body)
  return [process.execPath, join(scratch.root, "cli.mjs")]
}

/** What a current @aburi/cli answers: its `diff --help` lists the flag. */
function currentCli(): Promise<string[]> {
  return fakeCli(
    `process.stdout.write("Usage: aburi diff\\n  --fail-on <spec>\\n  --max-bytes <n>  cap diff.md\\n")\n`,
  )
}

function run(env: Record<string, string>, runner: readonly string[] = []) {
  return runScript("resolve-max-bytes.mjs", { env, args: runner })
}

describe("resolve-max-bytes.mjs", () => {
  it("defaults to what a comment body can hold, once the CLI says it can take it", async () => {
    const result = await run({ MAX_BYTES: "", FORMAT: "both" }, await currentCli())
    expect(result).toEqual({ status: 0, stdout: String(ABURI_COMMENT_BODY_MAX_BYTES), stderr: "" })
  })

  it("passes a caller's own budget through", async () => {
    const result = await run({ MAX_BYTES: "4000", FORMAT: "both" }, await currentCli())
    expect(result).toEqual({ status: 0, stdout: "4000", stderr: "" })
  })

  it.each([
    ["`0` as no cap", { MAX_BYTES: "0", FORMAT: "both" }],
    [
      "`format: json`, which writes no Markdown, as nothing to cap",
      { MAX_BYTES: "", FORMAT: "json" },
    ],
  ])("takes %s without probing anything", async (_, env) => {
    // No runner at all: reaching the probe would be an error, which is the assertion.
    expect(await run(env)).toEqual({ status: 0, stdout: "", stderr: "" })
  })

  it.each([
    "64kb",
    "-1",
    "1.5",
    " 4000",
    "00",
  ])("is exit 2 on %j, which is not a byte count", async (value) => {
    const result = await run({ MAX_BYTES: value, FORMAT: "both" }, [process.execPath])
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/^::error::max-bytes must be a non-negative integer/)
    expect(result.stdout).toBe("")
  })

  it("renders uncapped, with a warning naming both upgrade routes, against an older CLI", async () => {
    const older = await fakeCli(
      `process.stdout.write("Usage: aburi diff\\n  --fail-on <spec>\\n")\n`,
    )
    const result = await run({ MAX_BYTES: "", FORMAT: "both" }, older)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(/^::warning::This @aburi\/cli has no --max-bytes/)
    // `version` is meaningless under `cli: workspace`, where the CLI is the caller's own.
    expect(result.stderr).toContain("'version' input")
    expect(result.stderr).toContain("cli: workspace")
  })

  it("does not blame the CLI for a probe that could not run", async () => {
    const broken = await fakeCli(
      `process.stderr.write("ERR_PNPM_NO_MATCHING_VERSION\\n")\nprocess.exit(1)\n`,
    )
    const result = await run({ MAX_BYTES: "", FORMAT: "both" }, broken)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Could not ask the CLI whether it supports --max-bytes")
    expect(result.stderr).toContain("ERR_PNPM_NO_MATCHING_VERSION")
    expect(result.stderr).not.toContain("has no --max-bytes")
  })

  it.each([
    [
      "however long the help text is",
      `process.stdout.write("  --max-bytes <n>\\n" + "x".repeat(2_000_000) + "\\n")\n`,
    ],
    ["in help text a CLI writes to stderr", `process.stderr.write("  --max-bytes <n>\\n")\n`],
  ])("finds the flag %s", async (_, body) => {
    const result = await run({ MAX_BYTES: "", FORMAT: "both" }, await fakeCli(body))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(String(ABURI_COMMENT_BODY_MAX_BYTES))
  })
})
