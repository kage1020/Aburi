import { appendFileSync, readFileSync } from "node:fs"

const MARKER = "<!-- aburi:diff-comment -->"

const MAX_BYTES = 65536

const INPUT_ERROR = 2
const RUNTIME_ERROR = 1
const PER_PAGE = 100

/** One line, because the Checks UI shows the first line of an annotation and nothing after it. */
function fail(code, message) {
  process.stderr.write(`::error::${message.replace(/\s+/g, " ").trim()}\n`)
  process.exitCode = code
}

function reasonOf(error, depth = 2) {
  if (!(error instanceof Error)) return String(error)
  const code = typeof error.code === "string" ? `${error.code}: ` : ""
  const cause =
    depth > 0 && error.cause !== undefined && error.cause !== null
      ? ` (caused by ${reasonOf(error.cause, depth - 1)})`
      : ""
  return `${code}${error.message}${cause}`
}

function headers(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "aburi-github-action",
  }
}

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

function parseComment(row, { listed }) {
  if (typeof row !== "object" || row === null) return null
  if (typeof row.id !== "number") return null
  if (typeof row.body !== "string") return null
  if (typeof row.html_url !== "string") return null
  const comment = { id: row.id, body: row.body, htmlUrl: row.html_url }
  if (!listed) return comment
  if (typeof row.user !== "object" || row.user === null) return null
  if (typeof row.user.login !== "string") return null
  return { ...comment, author: { login: row.user.login, isBot: row.user.type === "Bot" } }
}

const INTEGRATION_REFUSAL = "Resource not accessible by integration"

async function isIntegrationRefusal(response) {
  if (response.status !== 403) return false
  const body = await response
    .clone()
    .json()
    .catch(() => null)
  return body?.message === INTEGRATION_REFUSAL
}

async function poster(context) {
  const response = await fetch(apiUrl(context.apiBase, "user"), {
    method: "GET",
    headers: headers(context.token),
  })
  if (await isIntegrationRefusal(response)) return { login: null }
  if (!response.ok) throw await githubError("identify the token's user", response)
  const user = await response.json()
  if (typeof user?.login !== "string" || user.login === "") {
    throw new Error("GitHub returned a user without a login for this token.")
  }
  return { login: user.login }
}

function isOwnComment(comment, self) {
  if (!comment.body.startsWith(MARKER)) return false
  return self.login === null ? comment.author.isBot : comment.author.login === self.login
}

async function findMarkerComment(context) {
  let skipped = 0
  let self
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
      const parsed = parseComment(row, { listed: true })
      if (parsed === null) {
        skipped += 1
        continue
      }
      if (!parsed.body.startsWith(MARKER)) continue
      self ??= await poster(context)
      if (isOwnComment(parsed, self)) return { comment: parsed, skipped }
    }
    if (rows.length < PER_PAGE) return { comment: null, skipped }
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
  const written = parseComment(await response.json(), { listed: false })
  if (written === null)
    throw new Error("GitHub returned a comment without id/body/html_url fields.")
  return written
}

function setOutputs(outcome) {
  const target = process.env.GITHUB_OUTPUT
  if (!target) return
  try {
    appendFileSync(target, `action=${outcome.action}\ncomment-id=${outcome.commentId}\n`)
  } catch (error) {
    process.stderr.write(
      `::warning::Comment ${outcome.commentId} was ${outcome.action}, but $GITHUB_OUTPUT could not be written (${reasonOf(error).replace(/\s+/g, " ")}); a caller reading comment-id sees an empty value.\n`,
    )
  }
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
  if (!/^[1-9][0-9]*$/.test(rawNumber)) {
    return {
      error: `PR_NUMBER must be a positive integer (got "${rawNumber}"). An event that carries no pull request in its payload has to be given the number explicitly.`,
    }
  }
  if (markdownPath === "") return { error: "MARKDOWN_PATH is empty: there is no report to post." }

  return { token, repository, prNumber: Number(rawNumber), markdownPath, apiBase }
}

async function main() {
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
  const body = raw.startsWith(MARKER) ? raw : `${MARKER}\n\n${raw}`
  const size = Buffer.byteLength(body, "utf8")
  if (size > MAX_BYTES) {
    fail(
      INPUT_ERROR,
      `${context.markdownPath} is ${size} bytes with the marker, over GitHub's ${MAX_BYTES}-byte comment limit; posting it would fail with a 422. Re-run the diff with a smaller --max-bytes and post that.`,
    )
    return
  }

  let outcome
  try {
    const { comment: existing, skipped } = await findMarkerComment(context)
    if (skipped > 0) {
      process.stderr.write(
        `::warning::${skipped} comment(s) came back without an id, body, html_url or author login and were skipped. If one of them was Aburi's, this run posts a second marker comment instead of rewriting the first.\n`,
      )
    }
    if (existing !== null && existing.body === body) {
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
