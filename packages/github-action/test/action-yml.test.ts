import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
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
