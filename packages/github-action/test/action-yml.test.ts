import { readFile, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_OUTPUT_DIRNAME, DIFF_JSON_FILENAME, DIFF_MD_FILENAME } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { ABURI_COMMENT_MARKER } from "../src/comment"

const ACTION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "action.yml")
/** The opening of a GitHub expression, escaped so this file does not hold one it forbids. */
const EXPRESSION_OPEN = `\${{`

const RESOLVER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "resolve-cli-bin.mjs",
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
    // The runner parses a manifest's descriptions and defaults as templates, with a context set
    // that does not include `github` — so an expression written as prose in a description fails
    // the whole manifest to load, for every consumer, before any step runs. Nothing catches that
    // until a workflow actually calls the action. See `docs/design/github-action.md` §2.
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

    // Defaults are template-evaluated too — `token`'s `${{ github.token }}` is the proof that they
    // are — so the same outage is one `default: ${{ github.event… }}` away. `github.token` is the
    // documented exception every action uses; nothing else has a reason to be an expression.
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
    // `pnpm dlx` installs the CLI outside the checkout, so a plugin ref named by package
    // (`languages: ["lang-typescript"]`) resolves from the store copy of @aburi/cli and finds
    // nothing. This mode runs the CLI that sits in the project's own node_modules instead.
    //
    // What the step must do with it is asserted here; what the resolver itself answers is asserted
    // by running it, in `resolve-cli-bin.test.ts`.
    const action = await loadAction()
    const diffStep = action.runs.steps.find((s) => s.id === "diff")
    const run = diffStep?.run ?? ""
    expect(run).toContain('node "$GITHUB_ACTION_PATH/scripts/resolve-cli-bin.mjs"')
    expect(run).toContain('runner=(node "$cli_bin")')
    await expect(stat(RESOLVER_PATH)).resolves.toBeDefined()
  })

  it("captures the resolver's stdout with its stderr sent elsewhere", async () => {
    // `2>&1` on this capture prepends any warning Node writes on the success path — an
    // ExperimentalWarning from the caller's NODE_OPTIONS, a corepack notice — to the path, which
    // then fails as `Cannot find module '(node:1234) ExperimentalWarning: …'`: exit 1, reported as
    // a CLI runtime error, pointing the reader at their own code.
    const action = await loadAction()
    const run = action.runs.steps.find((s) => s.id === "diff")?.run ?? ""
    const capture = run.split("\n").find((line) => line.includes("cli_bin=$("))
    expect(capture).toBeDefined()
    expect(capture).not.toContain("2>&1")
    expect(capture).toContain('2>"$resolve_error"')
  })

  it("reports the resolver's own failure as exit 2, with `cli-exit-code` set", async () => {
    // The failure exits before the step's own output writes at the end, so without this the output
    // comes back empty and a caller testing `cli-exit-code != '0'` reads a misconfiguration as
    // success.
    const action = await loadAction()
    const run = action.runs.steps.find((s) => s.id === "diff")?.run ?? ""
    const guard = run.slice(run.indexOf('if [ "$resolve_status" != "0" ]'))
    expect(guard).toContain('echo "cli-exit-code=2" >> "$GITHUB_OUTPUT"')
    expect(guard.slice(0, guard.indexOf("exit 2"))).toContain("cli-exit-code=2")
  })

  it("rejects a `cli` value that is neither `dlx` nor `workspace`", async () => {
    // Bound to this arm rather than to `exit 2`: the same step already holds two of those from the
    // `format` checks, so the coarser assertion survives deleting this branch outright.
    const action = await loadAction()
    const validateStep = action.runs.steps.find(
      (s) => typeof s.run === "string" && s.run.includes("cli must be one of"),
    )
    expect(validateStep?.run).toMatch(/case "\$CLI" in\s+dlx\|workspace\) : ;;/)
    expect(validateStep?.run).toContain("cli must be one of: dlx | workspace")
  })

  it("rejects a `comment` value that is neither `true` nor `false`", async () => {
    // Every non-`true` value reads as false downstream, so `comment: yes` would otherwise run
    // green, post nothing, and clear the `comment=true` + `format=json` check on the way past.
    const action = await loadAction()
    const validateStep = action.runs.steps.find(
      (s) => typeof s.run === "string" && s.run.includes("comment must be"),
    )
    expect(validateStep?.run).toMatch(/case "\$COMMENT" in\s+true\|false\) : ;;/)
    expect(validateStep?.run).toContain("comment must be true or false")
  })

  it("installs Node and pnpm only for the dlx path", async () => {
    // `cli: workspace` means the caller already installed the CLI, which they cannot have
    // done without their own Node and pnpm. Re-running the setup actions there would
    // replace the toolchain the workspace was installed with — a Node version skew between
    // `pnpm install` and the run that follows it is exactly the kind of failure this
    // action should not introduce.
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
    // A composite action stops at its first failing step. Without `always()`, a 403 in the comment
    // step ends the job on a GitHub API error and the tripped gate is never reported.
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
