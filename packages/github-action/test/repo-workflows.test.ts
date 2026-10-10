import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DIFF_MD_FILENAME } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const ANALYSIS_PATH = resolve(REPO, ".github", "workflows", "aburi.yml")
const COMPANION_PATH = resolve(REPO, ".github", "workflows", "aburi-comment.yml")

interface Step {
  readonly name?: string
  readonly id?: string
  readonly uses?: string
  readonly run?: string
  readonly if?: string
  readonly env?: Record<string, string>
  readonly with?: Record<string, string>
}

interface WorkflowShape {
  readonly name: string
  readonly on: {
    readonly pull_request?: unknown
    readonly workflow_run?: { readonly workflows?: readonly string[] }
  }
  readonly jobs: Record<string, { readonly steps: readonly Step[] }>
}

async function load(path: string): Promise<WorkflowShape> {
  const parsed = parse(await readFile(path, "utf8")) as unknown
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${path} did not parse`)
  return parsed as WorkflowShape
}

function steps(workflow: WorkflowShape): readonly Step[] {
  return Object.values(workflow.jobs).flatMap((job) => job.steps)
}

function stepUsing(workflow: WorkflowShape, action: string): Step {
  const step = steps(workflow).find((s) => s.uses?.startsWith(action))
  if (!step) throw new Error(`no step uses ${action}`)
  return step
}

function scriptOf(step: Step): string {
  return step.run ?? step.with?.script ?? ""
}

describe("aburi.yml and aburi-comment.yml", () => {
  it("triggers the companion on the analysis workflow's own name", async () => {
    const analysis = await load(ANALYSIS_PATH)
    const companion = await load(COMPANION_PATH)
    expect(analysis.on.pull_request, "the analysis half runs on pull_request").toBeDefined()
    expect(companion.on.workflow_run?.workflows).toContain(analysis.name)
  })

  it("uploads and downloads one artifact under one name", async () => {
    const analysis = await load(ANALYSIS_PATH)
    const companion = await load(COMPANION_PATH)
    const upload = stepUsing(analysis, "actions/upload-artifact@")
    const download = stepUsing(companion, "actions/download-artifact@")
    const name = upload.with?.name
    expect(name).toBeTruthy()
    expect(download.with?.name).toBe(name)
    const find = steps(companion).find((s) => s.id === "artifact")
    expect(scriptOf(find ?? {})).toContain(`'${name}'`)
  })

  it("looks for the hand-off marker the analysis half writes", async () => {
    const analysis = await load(ANALYSIS_PATH)
    const companion = await load(COMPANION_PATH)
    const handoff = steps(analysis).find((s) => s.id === "handoff")
    expect(handoff?.run).toContain("> out/comment-pending")
    const pending = steps(companion).find((s) => s.id === "pending")
    expect(pending?.run).toContain("report/comment-pending")
  })

  it("reads the report where the download puts the uploaded directory", async () => {
    const analysis = await load(ANALYSIS_PATH)
    const companion = await load(COMPANION_PATH)
    expect(stepUsing(analysis, "actions/upload-artifact@").with?.path).toBe("out/")
    const into = stepUsing(companion, "actions/download-artifact@").with?.path
    expect(into).toBeTruthy()
    const post = steps(companion).find((s) => s.name === "Post the report")
    expect(post?.env?.MARKDOWN_PATH).toBe(`${into}/${DIFF_MD_FILENAME}`)
  })

  it("runs the upsert script by the path it sparse-checks out", async () => {
    const companion = await load(COMPANION_PATH)
    const checkout = stepUsing(companion, "actions/checkout@")
    const sparse = checkout.with?.["sparse-checkout"]
    expect(sparse).toBe("packages/github-action/scripts")
    const post = steps(companion).find((s) => s.name === "Post the report")
    expect(post?.run).toContain(`node ${sparse}/upsert-comment.mjs`)
  })

  it("hands off on the comment's outcome, not on permission to post one", async () => {
    const analysis = await load(ANALYSIS_PATH)
    const guard = steps(analysis).find((s) => s.id === "handoff")?.if ?? ""
    expect(guard).toContain("steps.aburi.outputs.comment-id == ''")
    expect(guard).toContain("cli-exit-code == '0'")
    expect(guard).toContain("cli-exit-code == '3'")
    expect(guard).not.toContain("CAN_COMMENT")
  })
})
