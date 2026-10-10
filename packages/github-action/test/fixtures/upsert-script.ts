import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { parseOutputs, type RunResult, runScript } from "./scripts"

export interface UpsertRun extends RunResult {
  /** Everything the script wrote to `$GITHUB_OUTPUT`. */
  readonly outputs: Record<string, string>
}

/**
 * Runs `scripts/upsert-comment.mjs` for pull request 42 of kage1020/Aburi against the fake API
 * at `base`, with `report` as the Markdown to post; `env` overrides any variable, `undefined`
 * unsets it.
 */
export function useUpsertScript(): (
  base: string,
  report: string,
  env?: Readonly<Record<string, string | undefined>>,
) => Promise<UpsertRun> {
  const scratch = useScratchWorkspace("upsert-comment")
  return async (base, report, env = {}) => {
    await scratch.writeSource("diff.md", report)
    await scratch.writeSource("github-output", "")
    const markdownPath = join(scratch.root, "diff.md")
    const outputPath = join(scratch.root, "github-output")
    const result = await runScript("upsert-comment.mjs", {
      env: {
        GITHUB_API_URL: base,
        GITHUB_TOKEN: "secret-token",
        GITHUB_REPOSITORY: "kage1020/Aburi",
        PR_NUMBER: "42",
        MARKDOWN_PATH: markdownPath,
        GITHUB_OUTPUT: outputPath,
        ...env,
      },
    })
    return { ...result, outputs: parseOutputs(await readFile(outputPath, "utf8")) }
  }
}
