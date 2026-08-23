import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_OUTPUT_DIRNAME, DIFF_JSON_FILENAME, DIFF_MD_FILENAME } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { ABURI_COMMENT_MARKER } from "../src/comment"

const ACTION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "action.yml")

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
      "comment",
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

  it("has a diff step whose id is `diff` and a comment step guarded by `inputs.comment == 'true'`", async () => {
    const action = await loadAction()
    const diffStep = action.runs.steps.find((s) => s.id === "diff")
    expect(diffStep).toBeDefined()
    expect(diffStep?.run).toContain("--format")
    expect(diffStep?.run).toContain("--output-dir")

    const commentStep = action.runs.steps.find((s) => s.id === "post-comment")
    expect(commentStep).toBeDefined()
    expect(commentStep?.uses).toMatch(/^actions\/github-script@/)
    expect(commentStep?.if).toContain("inputs.comment == 'true'")
  })

  it("embeds the same marker string as the programmatic upsert helper", async () => {
    const raw = await readFile(ACTION_PATH, "utf8")
    expect(raw).toContain(ABURI_COMMENT_MARKER)
  })

  it("reads the exact artefact filenames that @aburi/cli writes", async () => {
    // Parity check between action.yml (which resolves diff-json-path /
    // diff-md-path via string concatenation in bash) and the CLI's actual
    // artifact-paths module. Without this, a rename of `diff.json` / `diff.md`
    // on the CLI side would surface only at runtime as an ENOENT inside the
    // github-script comment step — long after CI green.
    const raw = await readFile(ACTION_PATH, "utf8")
    expect(raw).toContain(`$OUTPUT_DIR/${DIFF_JSON_FILENAME}`)
    expect(raw).toContain(`$OUTPUT_DIR/${DIFF_MD_FILENAME}`)
    // Defence in depth: also assert the pre-refactor "aburi.diff.*" names are
    // gone. A stale copy would satisfy the concat above but still break at
    // runtime because the CLI never writes them.
    expect(raw).not.toContain("aburi.diff.json")
    expect(raw).not.toContain("aburi.diff.md")
  })

  it("defaults output-dir to the directory the CLI defaults to", async () => {
    // The action forwards this to `--output-dir`, so the two defaults have to be the same
    // string: a rename on the CLI side would leave the action writing somewhere the comment
    // step does not read, and the concat check above would still pass.
    const action = await loadAction()
    expect(action.inputs?.["output-dir"]?.default).toBe(DEFAULT_OUTPUT_DIRNAME)
  })

  it("skips the comment step when the CLI failed with runtime or input error", async () => {
    // Guarding on cli-exit-code == '0' || '3' means exit=1 (runtime) and
    // exit=2 (input) suppress the comment. Without that guard, github-script
    // would attempt to read a missing / partial diff.md and its ENOENT would
    // bury the CLI's real failure in the workflow log.
    const action = await loadAction()
    const commentStep = action.runs.steps.find((s) => s.id === "post-comment")
    expect(commentStep?.if).toContain("cli-exit-code")
    expect(commentStep?.if).toContain("'0'")
    expect(commentStep?.if).toContain("'3'")
  })

  it("documents the exit-code table in the cli-exit-code output description", async () => {
    // The initial revision of this action had the 1/3 codes swapped in every
    // docstring. Keep the description literal-checked so a future edit can't
    // regress the mapping.
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
