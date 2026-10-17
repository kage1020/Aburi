import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { parseOutputs, runStep } from "./fixtures/scripts"

const scratch = useScratchWorkspace("action-steps")

const ACTION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const saying = (text: string) => expect.stringContaining(text)

/** Runs a step body with `$GITHUB_OUTPUT` at a fresh file, and reads that file back. */
async function step(name: string, env: Record<string, string>) {
  const output = join(scratch.root, "github-output")
  await writeFile(output, "")
  const result = await runStep(name, { cwd: scratch.root, env: { ...env, GITHUB_OUTPUT: output } })
  return { ...result, outputs: parseOutputs(await readFile(output, "utf8")) }
}

/** An action directory whose resolver is a stand-in with `source` as its whole program. */
async function actionWithResolver(source: string): Promise<string> {
  const dir = join(scratch.root, "action")
  await mkdir(join(dir, "scripts"), { recursive: true })
  await writeFile(join(dir, "scripts", "resolve-refspec.mjs"), source)
  return dir
}

// On Windows `bash` on PATH can be WSL's launcher rather than the Git Bash a `shell: bash` step uses.
describe.skipIf(process.platform === "win32")("the action's step bodies", () => {
  it.each([
    {
      answer: "one line",
      source: 'process.stdout.write("a..b")',
      status: 0,
      outputs: { value: "a..b" },
    },
    {
      answer: "one line and its newline",
      source: 'process.stdout.write("a..b\\n")',
      status: 0,
      outputs: { value: "a..b" },
    },
    {
      answer: "a refusal",
      source: "process.exitCode = 2",
      status: 2,
      outputs: { "cli-exit-code": "2" },
    },
    { answer: "nothing", source: "", status: 1, outputs: { "cli-exit-code": "1" } },
    {
      answer: "two lines",
      source: 'process.stdout.write("a..b\\nvalue=c..d")',
      status: 1,
      outputs: { "cli-exit-code": "1" },
    },
  ])("refspec-step.sh, after a resolver that answers $answer, exits $status", async ({
    source,
    status,
    outputs,
  }) => {
    const actionPath = await actionWithResolver(source)
    const result = await step("refspec-step.sh", { GITHUB_ACTION_PATH: actionPath })
    expect(result.status).toBe(status)
    expect(result.outputs).toEqual(outputs)
  })

  it("refspec-step.sh keeps a multi-line refspec input out of the step's output", async () => {
    const result = await step("refspec-step.sh", {
      GITHUB_ACTION_PATH: ACTION_PATH,
      INPUT_REFSPEC: "main..HEAD\nvalue=a..b",
    })
    expect(result.status).toBe(2)
    expect(result.outputs).toEqual({ "cli-exit-code": "2" })
  })

  it.each([
    ["a clean diff", { DIFF_EXIT: "0" }, 0, ""],
    ["a tripped gate", { DIFF_EXIT: "3" }, 3, saying("::error::aburi diff exited with status 3")],
    ["a refused ref spec", { REFSPEC_EXIT: "2" }, 2, saying("before aburi diff ran")],
    ["a rejected input", { INPUTS_EXIT: "2" }, 2, saying("before aburi diff ran")],
    ["no code at all", {}, 1, saying("::error::The action stopped before aburi diff ran")],
  ])("exit-code-step.sh passes on %s as a number", async (_, env, status, stderr) => {
    const result = await step("exit-code-step.sh", env)
    expect(result.status).toBe(status)
    expect(result.outputs).toEqual({ "cli-exit-code": String(status) })
    expect(result.stderr).toEqual(stderr)
  })
})
