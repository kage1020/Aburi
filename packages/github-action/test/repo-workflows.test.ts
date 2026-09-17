import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DIFF_MD_FILENAME } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

/**
 * This repository's own two halves, pinned to each other.
 *
 * `aburi.yml` analyses a pull request and uploads the report; `aburi-comment.yml` picks that up on
 * `workflow_run` and posts it for a pull request whose own token could not (see
 * `docs/design/github-action.md`). Every name they agree on — the artifact, the hand-off
 * marker, the workflow name the trigger matches, the path the report lands at, the script that
 * posts it — is written in one file and read in the other, with nothing between them: no import,
 * no type, no resolver. And the companion runs from the **default branch**, so a rename that
 * breaks one of those pairs cannot fail on the pull request that makes it. It merges, and the next
 * fork pull request quietly gets no comment.
 *
 * Which is exactly the argument `upsert-comment.test.ts` already makes for the script path. These
 * are the rest of the couplings that argument covers.
 */
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
    // `workflows:` matches on `name:`, not on the filename, and nothing validates a value that
    // matches nothing — the companion simply never runs. `action-yml.test.ts` asserting
    // `action.name === "Aburi"` looks like this check and is not: that is the action's name.
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
    // The listing step finds the artifact by the same name before the download runs; a rename that
    // missed it would leave the companion reporting a broken hand-off on every run.
    const find = steps(companion).find((s) => s.id === "artifact")
    expect(scriptOf(find ?? {})).toContain(`'${name}'`)
  })

  it("looks for the hand-off marker the analysis half writes", async () => {
    // The sharp one. The companion reads the marker's absence as "the analysis run posted its own
    // comment" and exits 0 — so a rename here does not fail anything, anywhere. It just stops fork
    // pull requests getting comments, in green.
    const analysis = await load(ANALYSIS_PATH)
    const companion = await load(COMPANION_PATH)
    const handoff = steps(analysis).find((s) => s.id === "handoff")
    expect(handoff?.run).toContain("> out/comment-pending")
    const pending = steps(companion).find((s) => s.id === "pending")
    expect(pending?.run).toContain("report/comment-pending")
  })

  it("reads the report where the download puts the uploaded directory", async () => {
    // `path: out/` uploads the *contents* of `out/`, so the report lands at
    // `<download path>/<DIFF_MD_FILENAME>` — three values in two files, and the CLI owns the third.
    const analysis = await load(ANALYSIS_PATH)
    const companion = await load(COMPANION_PATH)
    expect(stepUsing(analysis, "actions/upload-artifact@").with?.path).toBe("out/")
    const into = stepUsing(companion, "actions/download-artifact@").with?.path
    expect(into).toBeTruthy()
    const post = steps(companion).find((s) => s.name === "Post the report")
    expect(post?.env?.MARKDOWN_PATH).toBe(`${into}/${DIFF_MD_FILENAME}`)
  })

  it("runs the upsert script by the path it sparse-checks out", async () => {
    // Nothing resolves this for the companion: it is a path into a checkout it asked for by
    // directory. Both halves of that pair live here.
    const companion = await load(COMPANION_PATH)
    const checkout = stepUsing(companion, "actions/checkout@")
    const sparse = checkout.with?.["sparse-checkout"]
    expect(sparse).toBe("packages/github-action/scripts")
    const post = steps(companion).find((s) => s.name === "Post the report")
    expect(post?.run).toContain(`node ${sparse}/upsert-comment.mjs`)
  })

  it("hands off on the comment's outcome, not on permission to post one", async () => {
    // `comment-id` is empty when the action was told not to comment *and* when it tried and was
    // refused. Keying the hand-off on the fork test instead would leave a 403 with no marker, and
    // the companion would read that absence as "already posted" — a green log asserting a comment
    // that is not there. The exit-code arm is the action's own comment gate, for its reason: 1 and
    // 2 mean a report that is missing or partial.
    const analysis = await load(ANALYSIS_PATH)
    const guard = steps(analysis).find((s) => s.id === "handoff")?.if ?? ""
    expect(guard).toContain("steps.aburi.outputs.comment-id == ''")
    expect(guard).toContain("cli-exit-code == '0'")
    expect(guard).toContain("cli-exit-code == '3'")
    expect(guard).not.toContain("CAN_COMMENT")
  })
})
