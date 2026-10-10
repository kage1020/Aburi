import { readFile, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_OUTPUT_DIRNAME } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { ABURI_COMMENT_BODY_MAX_BYTES, ABURI_COMMENT_MARKER } from "../src/comment"

const ACTION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "action.yml")
/** The opening of a GitHub expression, escaped so this file does not hold one it forbids. */
const EXPRESSION_OPEN = `\${{`

const RESOLVER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "resolve-cli-bin.mjs",
)

const MAX_BYTES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "resolve-max-bytes.mjs",
)

const REPORT_PATHS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "report-paths.mjs",
)

const UPSERT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "upsert-comment.mjs",
)

interface ActionShape {
  readonly name: string
  readonly description: string
  readonly inputs: Record<string, { readonly description: string; readonly default?: string }>
  readonly outputs: Record<string, { readonly description: string; readonly value: string }>
  readonly runs: {
    readonly using: string
    readonly steps: readonly {
      readonly name?: string
      readonly id?: string
      readonly uses?: string
      readonly run?: string
      readonly shell?: string
      readonly if?: string
      readonly env?: Record<string, string>
      readonly with?: Record<string, string>
    }[]
  }
}

async function loadAction(): Promise<ActionShape> {
  const raw = await readFile(ACTION_PATH, "utf8")
  const parsed = parse(raw) as unknown
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("action.yml did not parse to an object")
  }
  return parsed as ActionShape
}

describe("action.yml", () => {
  it("is a composite action with the documented inputs", async () => {
    const action = await loadAction()
    expect(action.name).toBe("Aburi")
    expect(action.runs.using).toBe("composite")
    for (const required of [
      "version",
      "refspec",
      "fail-on",
      "config",
      "output-dir",
      "format",
      "working-directory",
      "cli",
      "comment",
      "max-bytes",
      "token",
      "node-version",
      "pnpm-version",
    ]) {
      expect(action.inputs[required], `missing input: ${required}`).toBeDefined()
    }
  })

  it("defaults the CLI version to `latest` and the comment toggle to `true`", async () => {
    const action = await loadAction()
    expect(action.inputs.version?.default).toBe("latest")
    expect(action.inputs.comment?.default).toBe("true")
    expect(action.inputs.format?.default).toBe("both")
    expect(action.inputs["output-dir"]?.default).toBe("out")
  })

  it("resolves the CLI through `pnpm dlx @aburi/cli@<version>`", async () => {
    const raw = await readFile(ACTION_PATH, "utf8")
    expect(raw).toMatch(/pnpm dlx "@aburi\/cli@\$VERSION"/)
  })

  it("keeps a template expression out of every description, and out of every default but the token", async () => {
    const action = await loadAction()
    const described = [
      ["the action description", action.description] as const,
      ...Object.entries(action.inputs).map(([id, v]) => [`input ${id}`, v.description] as const),
      ...Object.entries(action.outputs).map(([id, v]) => [`output ${id}`, v.description] as const),
    ]
    for (const [where, description] of described) {
      expect(description, `missing description: ${where}`).toBeDefined()
      expect(description, `${where} holds an expression`).not.toContain(EXPRESSION_OPEN)
    }

    for (const [id, input] of Object.entries(action.inputs)) {
      const value = input.default ?? ""
      if (!value.includes(EXPRESSION_OPEN)) continue
      expect(value.trim(), `input ${id} default holds an expression`).toBe(
        `${EXPRESSION_OPEN} github.token }}`,
      )
    }
  })

  it("defaults `cli` to the dlx resolution the `version` input describes", async () => {
    const action = await loadAction()
    expect(action.inputs.cli?.default).toBe("dlx")
  })

  it("runs the workspace's own CLI through the resolver script when `cli: workspace`", async () => {
    const action = await loadAction()
    const diffStep = action.runs.steps.find((s) => s.id === "diff")
    const run = diffStep?.run ?? ""
    expect(run).toContain('node "$GITHUB_ACTION_PATH/scripts/resolve-cli-bin.mjs"')
    expect(run).toContain('runner=(node "$cli_bin")')
    await expect(stat(RESOLVER_PATH)).resolves.toBeDefined()
  })

  it("captures the resolver's stdout with its stderr sent elsewhere", async () => {
    const action = await loadAction()
    const run = action.runs.steps.find((s) => s.id === "diff")?.run ?? ""
    const capture = run.split("\n").find((line) => line.includes("cli_bin=$("))
    expect(capture).toBeDefined()
    expect(capture).not.toContain("2>&1")
    expect(capture).toContain('2>"$resolve_error"')
  })

  it("reports the resolver's own failure as exit 2, with `cli-exit-code` set", async () => {
    const action = await loadAction()
    const run = action.runs.steps.find((s) => s.id === "diff")?.run ?? ""
    const guard = run.slice(run.indexOf('if [ "$resolve_status" != "0" ]'))
    expect(guard).toContain('echo "cli-exit-code=2" >> "$GITHUB_OUTPUT"')
    expect(guard.slice(0, guard.indexOf("exit 2"))).toContain("cli-exit-code=2")
  })

  it("rejects a `cli` value that is neither `dlx` nor `workspace`", async () => {
    const action = await loadAction()
    const validateStep = action.runs.steps.find(
      (s) => typeof s.run === "string" && s.run.includes("cli must be one of"),
    )
    expect(validateStep?.run).toMatch(/case "\$CLI" in\s+dlx\|workspace\) : ;;/)
    expect(validateStep?.run).toContain("cli must be one of: dlx | workspace")
  })

  it("rejects a `comment` value that is neither `true` nor `false`", async () => {
    const action = await loadAction()
    const validateStep = action.runs.steps.find(
      (s) => typeof s.run === "string" && s.run.includes("comment must be"),
    )
    expect(validateStep?.run).toMatch(/case "\$COMMENT" in\s+true\|false\) : ;;/)
    expect(validateStep?.run).toContain("comment must be true or false")
  })

  it("decides the size cap through the committed script, which is where it is tested", async () => {
    const action = await loadAction()
    const run = action.runs.steps.find((s) => s.id === "diff")?.run ?? ""
    expect(run).toContain('node "$GITHUB_ACTION_PATH/scripts/resolve-max-bytes.mjs"')
    expect(run).toContain('if [ -n "$budget" ]; then args+=(--max-bytes "$budget"); fi')
    expect(action.inputs["max-bytes"]?.default).toBe("")
    await expect(stat(MAX_BYTES_PATH)).resolves.toBeDefined()
  })

  it("holds the default budget to the marker the upsert prepends", async () => {
    const source = await readFile(MAX_BYTES_PATH, "utf8")
    expect(source).toContain(`const DEFAULT_BUDGET = ${ABURI_COMMENT_BODY_MAX_BYTES}`)
  })

  it("caps under `comment: false` too, because that is the mode a fork's pull request runs in", async () => {
    const action = await loadAction()
    const diffStep = action.runs.steps.find((s) => s.id === "diff")
    expect(diffStep?.env?.COMMENT).toBeUndefined()
    expect(diffStep?.run).not.toContain('"$COMMENT"')
  })

  it("resolves the budget after the runner, and passes it to the CLI", async () => {
    const action = await loadAction()
    const lines = (action.runs.steps.find((s) => s.id === "diff")?.run ?? "").split("\n")
    const runnerLine = lines.findIndex((line) => line.includes("runner=(pnpm dlx"))
    const budgetLine = lines.findIndex((line) => line.includes("resolve-max-bytes.mjs"))
    const passLine = lines.findIndex((line) => line.includes('args+=(--max-bytes "$budget")'))
    expect(runnerLine).toBeGreaterThanOrEqual(0)
    expect(budgetLine).toBeGreaterThan(runnerLine)
    expect(passLine).toBeGreaterThan(budgetLine)
  })

  it("reports a rejected `max-bytes` as exit 2, with `cli-exit-code` set", async () => {
    const action = await loadAction()
    const run = action.runs.steps.find((s) => s.id === "diff")?.run ?? ""
    const guard = run.slice(run.indexOf('if [ "$budget_status" != "0" ]'))
    expect(guard).toContain('echo "cli-exit-code=2" >> "$GITHUB_OUTPUT"')
    expect(guard.slice(0, guard.indexOf("exit 2"))).toContain("cli-exit-code=2")
  })

  it("rejects a `max-bytes` that is not a number before installing a toolchain", async () => {
    const action = await loadAction()
    const validateStep = action.runs.steps.find(
      (s) => typeof s.run === "string" && s.run.includes("max-bytes must be"),
    )
    expect(validateStep?.run).toContain("max-bytes must be a non-negative integer")
    expect(validateStep?.env?.MAX_BYTES).toContain("inputs.max-bytes")
    // Named for what it is: a fail-fast duplicate, not the only guard.
    expect(validateStep?.run).toContain("resolve-max-bytes.mjs")
  })

  it("installs Node and pnpm only for the dlx path", async () => {
    const action = await loadAction()
    const setupSteps = action.runs.steps.filter(
      (s) => s.uses?.startsWith("pnpm/action-setup@") || s.uses?.startsWith("actions/setup-node@"),
    )
    expect(setupSteps).toHaveLength(2)
    for (const step of setupSteps) {
      expect(step.if, `missing guard on ${step.uses}`).toContain("inputs.cli == 'dlx'")
    }
  })

  it("has a diff step whose id is `diff` and a comment step guarded by `inputs.comment == 'true'`", async () => {
    const action = await loadAction()
    const diffStep = action.runs.steps.find((s) => s.id === "diff")
    expect(diffStep).toBeDefined()
    expect(diffStep?.run).toContain("--format")
    expect(diffStep?.run).toContain("--output-dir")

    const commentStep = action.runs.steps.find((s) => s.id === "post-comment")
    expect(commentStep).toBeDefined()
    expect(commentStep?.run).toContain('node "$GITHUB_ACTION_PATH/scripts/upsert-comment.mjs"')
    expect(commentStep?.if).toContain("inputs.comment == 'true'")
  })

  it("upserts through the committed script, which `aburi-comment.yml` runs too", async () => {
    await expect(stat(UPSERT_PATH)).resolves.toBeDefined()
    expect(await readFile(UPSERT_PATH, "utf8")).toContain(ABURI_COMMENT_MARKER)
  })

  it("resolves the comment step's pull request number from both halves of the event", async () => {
    const action = await loadAction()
    const env = action.runs.steps.find((s) => s.id === "post-comment")?.env ?? {}
    expect(env.PR_NUMBER).toContain("github.event.pull_request.number")
    expect(env.PR_NUMBER).toContain("github.event.issue.number")
  })

  it("names the report paths with the committed script", async () => {
    // What the script answers, filenames included, is asserted by running it in
    // `report-paths.test.ts`; this pins only that the diff step is what runs it.
    await expect(stat(REPORT_PATHS_PATH)).resolves.toBeDefined()
    const action = await loadAction()
    const diffStep = action.runs.steps.find((s) => s.id === "diff")
    expect(diffStep?.run).toContain('paths=$(node "$GITHUB_ACTION_PATH/scripts/report-paths.mjs")')
  })

  it("writes cli-exit-code before working out the report paths", async () => {
    // A failure in the script must not cost the caller the gate's verdict.
    const action = await loadAction()
    const run = action.runs.steps.find((s) => s.id === "diff")?.run ?? ""
    const exitCode = run.indexOf('echo "cli-exit-code=$status"')
    expect(exitCode).toBeGreaterThan(-1)
    expect(exitCode).toBeLessThan(run.indexOf("scripts/report-paths.mjs"))
  })

  it("no longer names the pre-refactor aburi.diff.* artefacts", async () => {
    // The CLI never writes them, so a stale copy would break only at runtime.
    const raw = await readFile(ACTION_PATH, "utf8")
    expect(raw).not.toContain("aburi.diff.json")
    expect(raw).not.toContain("aburi.diff.md")
  })

  it("posts only when the diff step named a Markdown file this run wrote", async () => {
    const action = await loadAction()
    const commentStep = action.runs.steps.find((s) => s.id === "post-comment")
    expect(commentStep?.if).toContain("steps.diff.outputs.diff-md-path != ''")
  })

  it("hands the comment step the report path as the diff step resolved it", async () => {
    // The path is absolute already. Prefixing `working-directory` turned an absolute
    // `output-dir` into `.//home/...`, a relative path under the repository root that was not
    // there, and the upsert failed on a diff that had succeeded.
    const action = await loadAction()
    const env = action.runs.steps.find((s) => s.id === "post-comment")?.env ?? {}
    expect(env.MARKDOWN_PATH).toBe(`${EXPRESSION_OPEN} steps.diff.outputs.diff-md-path }}`)
  })

  it("defaults output-dir to the directory the CLI defaults to", async () => {
    // The action forwards this to `--output-dir`, so the two defaults have to be the same
    // string: a rename on the CLI side would leave the action writing somewhere the comment
    // step does not read.
    const action = await loadAction()
    expect(action.inputs?.["output-dir"]?.default).toBe(DEFAULT_OUTPUT_DIRNAME)
  })

  it("skips the comment step when the CLI failed with runtime or input error", async () => {
    const action = await loadAction()
    const commentStep = action.runs.steps.find((s) => s.id === "post-comment")
    expect(commentStep?.if).toContain("cli-exit-code")
    expect(commentStep?.if).toContain("'0'")
    expect(commentStep?.if).toContain("'3'")
  })

  it("documents the exit-code table in the cli-exit-code output description", async () => {
    const action = await loadAction()
    const description = action.outputs["cli-exit-code"]?.description ?? ""
    expect(description).toContain("1=runtime")
    expect(description).toContain("2=input")
    expect(description).toContain("3=")
    expect(description).toContain("gate")
  })

  it("propagates the CLI exit code so PR checks reflect a triggered gate", async () => {
    const action = await loadAction()
    const propagate = action.runs.steps.find(
      (s) => typeof s.run === "string" && s.run.includes('exit "$CLI_EXIT"'),
    )
    expect(propagate).toBeDefined()
    expect(propagate?.if).toBe("always()")
  })

  it("declares outputs for artefact paths and the comment id", async () => {
    const action = await loadAction()
    for (const key of [
      "diff-json-path",
      "diff-md-path",
      "cli-exit-code",
      "comment-id",
      "comment-action",
    ]) {
      expect(action.outputs[key], `missing output: ${key}`).toBeDefined()
    }
  })

  it("rejects an event without PR refs when refspec is empty", async () => {
    const action = await loadAction()
    const refspecStep = action.runs.steps.find((s) => s.id === "refspec")
    expect(refspecStep).toBeDefined()
    expect(refspecStep?.run).toContain("pull_request")
    expect(refspecStep?.run).toContain("exit 2")
  })

  it("fails input validation when `comment: true` but `format: json`", async () => {
    const action = await loadAction()
    const validateStep = action.runs.steps.find(
      (s) => typeof s.run === "string" && s.run.includes("comment=true requires format"),
    )
    expect(validateStep).toBeDefined()
  })
})
