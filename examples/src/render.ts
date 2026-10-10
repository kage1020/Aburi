import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import { EXIT, runDiff } from "@aburi/cli"
import type { DiffResult } from "@aburi/types"

const execFileAsync = promisify(execFile)

const CONFIG_FILENAME = "aburi.json"

export interface Showcase {
  /** The example's directory name, which is also its page's URL segment. */
  readonly slug: string
  readonly title: string
  /** The README's first paragraph. */
  readonly summary: string
  /** The whole page as Markdown. */
  readonly page: string
}

/**
 * Commits `before/` and then `after/` to a scratch repository, runs `aburi diff HEAD~1..HEAD` there and
 * renders the README, the config, the source change and the report as one page.
 */
export async function renderExample(dir: string): Promise<Showcase> {
  const slug = basename(dir)
  try {
    return await render(dir, slug)
  } catch (error) {
    throw new Error(`${slug}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

async function render(dir: string, slug: string): Promise<Showcase> {
  const { title, narrative } = parseReadme(await readFile(join(dir, "README.md"), "utf8"))
  const config = await readFile(join(dir, CONFIG_FILENAME), "utf8")

  const scratch = await realpath(await mkdtemp(join(tmpdir(), "aburi-showcase-")))
  try {
    const repo = join(scratch, "repo")
    await mkdir(repo)
    await git(repo, ["init", "--quiet"])
    await commitSide(repo, dir, "before")
    await commitSide(repo, dir, "after")
    const sourceDiff = await git(repo, ["diff", "--no-color", "--no-ext-diff", "HEAD~1", "HEAD"])
    const report = await diffReport(repo, join(scratch, "out"))
    return {
      slug,
      title,
      summary: (narrative.split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim(),
      page: [
        `# ${title}`,
        narrative,
        "## Configuration",
        fenced("json", config),
        "## The change",
        fenced("diff", sourceDiff),
        "## What `aburi diff` reports",
        "::: v-pre",
        nestHeadings(report),
        ":::",
      ].join("\n\n"),
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function parseReadme(readme: string): { title: string; narrative: string } {
  const match = /^# (.+)\n([\s\S]*)$/.exec(lf(readme))
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("an example's README.md must open with a `# Title` line")
  }
  return { title: match[1].trim(), narrative: match[2].trim() }
}

async function commitSide(repo: string, dir: string, side: "before" | "after"): Promise<void> {
  for (const entry of await readdir(repo)) {
    if (entry !== ".git") await rm(join(repo, entry), { recursive: true, force: true })
  }
  await cp(join(dir, side), repo, { recursive: true })
  await cp(join(dir, CONFIG_FILENAME), join(repo, CONFIG_FILENAME))
  await git(repo, ["add", "--all"])
  await git(repo, ["commit", "--quiet", "--allow-empty", "--message", side])
}

async function diffReport(repo: string, outputDir: string): Promise<string> {
  const warnings: string[] = []
  const report = await runDiff({
    cwd: repo,
    refSpec: "HEAD~1..HEAD",
    format: "both",
    outputDir,
    warn: (message) => {
      warnings.push(message)
    },
  })
  if (report.exitCode !== EXIT.SUCCESS) {
    throw new Error(
      [`aburi diff exited ${report.exitCode} (${report.summaryLine})`, ...warnings].join("\n"),
    )
  }
  if (report.diffJsonPath === null || report.diffMdPath === null) {
    throw new Error(`aburi diff wrote no report: ${report.summaryLine}`)
  }
  const { summary } = JSON.parse(await readFile(report.diffJsonPath, "utf8")) as DiffResult
  const { added, removed, changed, moved, movedChanged } = summary
  if (added + removed + changed + moved + movedChanged === 0) {
    throw new Error(`aburi diff reports no change (${report.summaryLine})`)
  }
  return lf(await readFile(report.diffMdPath, "utf8")).trim()
}

/** The report's own headings move two levels down, under the page's `##` sections. */
function nestHeadings(markdown: string): string {
  return markdown.replace(/^(#{1,4}) /gm, "##$1 ")
}

function fenced(language: string, body: string): string {
  return `\`\`\`${language}\n${lf(body).replace(/\n?$/, "\n")}\`\`\``
}

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...GIT_CONFIG, ...args], {
    cwd,
    env: gitEnv(cwd),
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

const GIT_CONFIG = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "init.defaultBranch=main",
  "-c",
  "commit.gpgsign=false",
]

function gitEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(cwd, ".absent-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Aburi examples",
    GIT_AUTHOR_EMAIL: "examples@aburi.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Aburi examples",
    GIT_COMMITTER_EMAIL: "examples@aburi.invalid",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  }
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[name]
  return env
}
