// Upsert one Aburi report comment on a pull request: find the comment carrying the hidden marker,
// rewrite it in place, or create it when there is none.
//
// This is the step `comment: true` runs, and it is also what the `workflow_run` companion runs for
// a pull request whose own token could not post — see `docs/design/github-action.md` §5.1. Those
// two callers are the reason this is a file rather than an inline script: the second one has no
// action to call, only a checkout, and a second copy of the upsert would be a second marker string
// to keep in step.
//
// Plain `.mjs`, committed rather than built, because a consumer references the action by path
// (`uses: kage1020/Aburi/packages/github-action@main`) and nothing builds this repository for them.
// `src/comment.ts` is the same flow as a library, for callers importing the package;
// `test/upsert-comment.test.ts` pins the two to the same marker.
//
// Input is environment only, never argv: the Markdown is attacker-influenced on a fork's pull
// request (it names the symbols that pull request declares), and a path or a body on a command
// line is one shell quoting mistake away from being run.
//
// Exit codes: 0 done, 2 the caller's setup is wrong, 1 the GitHub API said no. Both failures write
// a one-line `::error::` annotation, so a caller needs no wrapper around this.

import { appendFileSync, readFileSync } from "node:fs"

/**
 * Must equal `ABURI_COMMENT_MARKER` in `src/comment.ts`; `test/upsert-comment.test.ts` asserts it.
 * Stable across releases: comments already posted carry this exact string, and changing it orphans
 * every one of them.
 */
const MARKER = "<!-- aburi:diff-comment -->"

const INPUT_ERROR = 2
const RUNTIME_ERROR = 1
const PER_PAGE = 100

/** One line, because the Checks UI shows the first line of an annotation and nothing after it. */
function fail(code, message) {
  process.stderr.write(`::error::${message.replace(/\s+/g, " ").trim()}\n`)
  process.exitCode = code
}

function reasonOf(error) {
  if (!(error instanceof Error)) return String(error)
  const code = typeof error.code === "string" ? `${error.code}: ` : ""
  return `${code}${error.message}`
}

function headers(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "aburi-github-action",
  }
}

/**
 * Preserve any base path the host mounts the API under: GitHub Enterprise Server serves it from
 * `/api/v3`, and `new URL("/repos/…", base)` would throw that segment away.
 */
function apiUrl(apiBase, relativePath) {
  const normalised = apiBase.endsWith("/") ? apiBase : `${apiBase}/`
  return new URL(relativePath, normalised)
}

async function githubError(operation, response) {
  const snippet = await response
    .text()
    .then((raw) => raw.slice(0, 400))
    .catch(() => "<no body>")
  return new Error(
    `GitHub API failed to ${operation}: ${response.status} ${response.statusText}. ${snippet}`,
  )
}

function parseComment(row) {
  if (typeof row !== "object" || row === null) return null
  if (typeof row.id !== "number") return null
  if (typeof row.body !== "string") return null
  if (typeof row.html_url !== "string") return null
  return { id: row.id, body: row.body, htmlUrl: row.html_url }
}

async function findMarkerComment(context) {
  for (let page = 1; ; page++) {
    const url = apiUrl(
      context.apiBase,
      `repos/${context.repository}/issues/${context.prNumber}/comments`,
    )
    url.searchParams.set("per_page", String(PER_PAGE))
    url.searchParams.set("page", String(page))
    const response = await fetch(url, { method: "GET", headers: headers(context.token) })
    if (!response.ok) throw await githubError("list PR comments", response)
    const rows = await response.json()
    if (!Array.isArray(rows)) {
      throw new Error(
        `GitHub returned a non-array response listing comments on #${context.prNumber}.`,
      )
    }
    for (const row of rows) {
      const parsed = parseComment(row)
      if (parsed?.body.includes(MARKER)) return parsed
    }
    if (rows.length < PER_PAGE) return null
  }
}

async function writeComment(context, { method, path, body }) {
  const response = await fetch(apiUrl(context.apiBase, path), {
    method,
    headers: { ...headers(context.token), "content-type": "application/json" },
    body: JSON.stringify({ body }),
  })
  if (!response.ok) {
    throw await githubError(method === "POST" ? "create PR comment" : "update PR comment", response)
  }
  const written = parseComment(await response.json())
  if (written === null)
    throw new Error("GitHub returned a comment without id/body/html_url fields.")
  return written
}

/** Step outputs, when a step is what we are running in. Absent outside Actions, which is fine. */
function setOutputs(outcome) {
  const target = process.env.GITHUB_OUTPUT
  if (!target) return
  appendFileSync(target, `action=${outcome.action}\ncomment-id=${outcome.commentId}\n`)
}

function readContext() {
  const token = process.env.GITHUB_TOKEN ?? ""
  const repository = process.env.GITHUB_REPOSITORY ?? ""
  const rawNumber = process.env.PR_NUMBER ?? ""
  const markdownPath = process.env.MARKDOWN_PATH ?? ""
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com"

  if (token === "")
    return { error: "GITHUB_TOKEN is empty: nothing can be posted without a token." }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    return { error: `GITHUB_REPOSITORY must be "owner/repo" (got "${repository}").` }
  }
  // Parsed strictly, not with `Number()`: on the `workflow_run` path this number decides which pull
  // request the report lands on, and a "12abc" that reads as 12 would put it on someone else's.
  if (!/^[1-9][0-9]*$/.test(rawNumber)) {
    return {
      error: `PR_NUMBER must be a positive integer (got "${rawNumber}"). An event that carries no pull request in its payload has to be given the number explicitly.`,
    }
  }
  if (markdownPath === "") return { error: "MARKDOWN_PATH is empty: there is no report to post." }

  return { token, repository, prNumber: Number(rawNumber), markdownPath, apiBase }
}

async function main() {
  // Under `cli: workspace` this runs on whatever Node the caller installed the workspace with, and
  // a global `fetch` is Node 18 and up. Saying so is worth three lines: the alternative is a
  // `fetch is not defined` on the last step of a job that has already done all the work.
  if (typeof fetch !== "function") {
    fail(
      INPUT_ERROR,
      `This Node has no global fetch (${process.version}); Node 18 or newer is required to post the comment.`,
    )
    return
  }

  const context = readContext()
  if (context.error) {
    fail(INPUT_ERROR, context.error)
    return
  }

  let raw
  try {
    raw = readFileSync(context.markdownPath, "utf8")
  } catch (error) {
    fail(INPUT_ERROR, `${context.markdownPath} could not be read (${reasonOf(error)}).`)
    return
  }
  const body = raw.includes(MARKER) ? raw : `${MARKER}\n\n${raw}`

  let outcome
  try {
    const existing = await findMarkerComment(context)
    if (existing !== null && existing.body === body) {
      // The same bytes as last time: a PATCH here would bump `updated_at` and notify every
      // subscriber to say nothing had changed.
      outcome = { action: "unchanged", commentId: existing.id, url: existing.htmlUrl }
    } else if (existing !== null) {
      const updated = await writeComment(context, {
        method: "PATCH",
        path: `repos/${context.repository}/issues/comments/${existing.id}`,
        body,
      })
      outcome = { action: "updated", commentId: updated.id, url: updated.htmlUrl }
    } else {
      const created = await writeComment(context, {
        method: "POST",
        path: `repos/${context.repository}/issues/${context.prNumber}/comments`,
        body,
      })
      outcome = { action: "created", commentId: created.id, url: created.htmlUrl }
    }
  } catch (error) {
    fail(RUNTIME_ERROR, reasonOf(error))
    return
  }

  setOutputs(outcome)
  process.stdout.write(`Aburi comment ${outcome.commentId} ${outcome.action}: ${outcome.url}\n`)
}

await main()
