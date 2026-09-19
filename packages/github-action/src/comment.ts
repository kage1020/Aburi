/**
 * Hidden HTML marker embedded at the top of every comment we post; the upsert step finds the
 * comment to update in place by it. Keep it stable across releases: changing it would orphan
 * users' existing PR comments unless a migration step also matches the previous value.
 */
export const ABURI_COMMENT_MARKER = "<!-- aburi:diff-comment -->"

/** What {@link ensureMarker} puts between the marker and the body; the budget below counts it. */
const MARKER_SEPARATOR = "\n\n"

/**
 * GitHub's ceiling on an issue-comment body. A create or update carrying more is rejected with
 * a 422 and nothing is posted — there is no partial write to fall back on.
 */
export const GITHUB_COMMENT_MAX_BYTES = 65536

/**
 * What a report rendered for the default marker may weigh: the ceiling less that marker and its
 * separator. This is the number to render with — `aburi diff --max-bytes <n>`
 * (`markdown-projection.md`) drops whole sections to meet it — and the default
 * `scripts/resolve-max-bytes.mjs` holds.
 *
 * The action passes it on every run that writes Markdown, `comment: false` included, because
 * that is the mode a fork's pull request uses and its artefact is posted by another workflow
 * (`docs/design/github-action.md`). A caller naming its own `max-bytes` gets that instead,
 * and `max-bytes: 0` gets no cap at all.
 *
 * A caller passing its own {@link UpsertOptions.marker} should derive its own budget: a longer
 * marker leaves the report less room than this.
 */
export const ABURI_COMMENT_BODY_MAX_BYTES =
  GITHUB_COMMENT_MAX_BYTES - Buffer.byteLength(`${ABURI_COMMENT_MARKER}${MARKER_SEPARATOR}`, "utf8")

export interface PullRequestRef {
  readonly owner: string
  readonly repo: string
  readonly pullNumber: number
}

export interface UpsertOptions {
  readonly ref: PullRequestRef
  readonly body: string
  readonly token: string
  /** Override the API host (GitHub Enterprise Server). Default: `https://api.github.com`. */
  readonly apiBase?: string
  /** Injected `fetch`, so tests can drive the flow with a fake. Defaults to the global. */
  readonly fetch?: typeof globalThis.fetch
  /** Marker override. Defaults to {@link ABURI_COMMENT_MARKER}. */
  readonly marker?: string
}

export type UpsertOutcome =
  | { readonly action: "created"; readonly commentId: number; readonly url: string }
  | { readonly action: "updated"; readonly commentId: number; readonly url: string }
  | { readonly action: "unchanged"; readonly commentId: number; readonly url: string }

/**
 * Locate an existing marker comment on the PR and update it, or create a new one if none
 * exists. Returns `unchanged` when the current body already matches, so a re-run of the same
 * workflow does not bump `updated_at` and inflate notifications.
 *
 * PR-level comments live on the *issues* endpoint; line-level review comments are a different
 * endpoint this deliberately does not touch.
 */
export async function upsertPullRequestComment(options: UpsertOptions): Promise<UpsertOutcome> {
  const marker = options.marker ?? ABURI_COMMENT_MARKER
  const bodyWithMarker = ensureMarker(options.body, marker)
  // Measured before the round trip rather than left to the API. GitHub answers an oversized body
  // with a bare 422 whose message says nothing about size, after the list call has already paged
  // through every comment on the pull request; this says what is wrong and what renders smaller.
  const size = Buffer.byteLength(bodyWithMarker, "utf8")
  if (size > GITHUB_COMMENT_MAX_BYTES) {
    // The budget in the message is derived from the marker actually in use, not from the default
    // one: a caller with a longer marker that re-rendered at 65507 would overflow again, on the
    // advice of this very line.
    const budget =
      GITHUB_COMMENT_MAX_BYTES - Buffer.byteLength(`${marker}${MARKER_SEPARATOR}`, "utf8")
    throw new Error(
      `Comment body is ${size} bytes, over GitHub's ${GITHUB_COMMENT_MAX_BYTES}-byte limit; ` +
        `GitHub would reject it with a 422. Render the report with a size cap — ` +
        `aburi diff --max-bytes ${budget} — and post that.`,
    )
  }
  const api: ApiContext = {
    ref: options.ref,
    apiBase: options.apiBase ?? "https://api.github.com",
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
  }

  const existing = await findMarkerComment(api, marker)
  if (existing !== null) {
    if (existing.body === bodyWithMarker) {
      return { action: "unchanged", commentId: existing.id, url: existing.htmlUrl }
    }
    const updated = await writeComment(
      api,
      "PATCH",
      `repos/${api.ref.owner}/${api.ref.repo}/issues/comments/${existing.id}`,
      bodyWithMarker,
    )
    return { action: "updated", commentId: updated.id, url: updated.htmlUrl }
  }

  const created = await writeComment(api, "POST", commentsPath(api.ref), bodyWithMarker)
  return { action: "created", commentId: created.id, url: created.htmlUrl }
}

interface StoredComment {
  readonly id: number
  readonly body: string
  readonly htmlUrl: string
}

/** What every call to the API needs: where it is, who is asking, and how to reach it. */
interface ApiContext {
  readonly ref: PullRequestRef
  readonly apiBase: string
  readonly token: string
  readonly fetch: typeof globalThis.fetch
}

function commentsPath(ref: PullRequestRef): string {
  return `repos/${ref.owner}/${ref.repo}/issues/${ref.pullNumber}/comments`
}

async function findMarkerComment(api: ApiContext, marker: string): Promise<StoredComment | null> {
  const perPage = 100
  for (let page = 1; ; page++) {
    const url = buildApiUrl(api.apiBase, commentsPath(api.ref))
    url.searchParams.set("per_page", String(perPage))
    url.searchParams.set("page", String(page))
    const response = await api.fetch(url, { method: "GET", headers: authHeaders(api.token) })
    if (!response.ok) {
      throw await githubError("list PR comments", response)
    }
    const rows = (await response.json()) as unknown
    if (!Array.isArray(rows)) {
      throw new Error(
        `GitHub returned a non-array response listing PR comments for #${api.ref.pullNumber}.`,
      )
    }
    for (const row of rows) {
      const parsed = parseComment(row)
      if (parsed?.body.includes(marker)) return parsed
    }
    if (rows.length < perPage) return null
  }
}

/** Create (`POST`) or update (`PATCH`) a comment; the two differ only in method and path. */
async function writeComment(
  api: ApiContext,
  method: "POST" | "PATCH",
  path: string,
  body: string,
): Promise<StoredComment> {
  const response = await api.fetch(buildApiUrl(api.apiBase, path), {
    method,
    headers: { ...authHeaders(api.token), "content-type": "application/json" },
    body: JSON.stringify({ body }),
  })
  const operation = method === "POST" ? "create PR comment" : "update PR comment"
  if (!response.ok) throw await githubError(operation, response)
  const written = parseComment(await response.json())
  if (written === null) {
    throw new Error("GitHub returned a comment response without id/body/html_url fields.")
  }
  return written
}

/**
 * Build an absolute URL under the API base while preserving any base path (GitHub Enterprise
 * Server mounts the API under `/api/v3`): `new URL("/x", base)` would drop it.
 */
function buildApiUrl(apiBase: string, relativePath: string): URL {
  const normalised = apiBase.endsWith("/") ? apiBase : `${apiBase}/`
  return new URL(relativePath, normalised)
}

function authHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "aburi-github-action",
  }
}

async function githubError(operation: string, response: Response): Promise<Error> {
  const snippet = await response
    .text()
    .then((raw) => raw.slice(0, 400))
    .catch(() => "<no body>")
  return new Error(
    `GitHub API failed to ${operation}: ${response.status} ${response.statusText}. ${snippet}`,
  )
}

function parseComment(row: unknown): StoredComment | null {
  if (typeof row !== "object" || row === null) return null
  const id = (row as { id?: unknown }).id
  const body = (row as { body?: unknown }).body
  const htmlUrl = (row as { html_url?: unknown }).html_url
  if (typeof id !== "number") return null
  if (typeof body !== "string") return null
  if (typeof htmlUrl !== "string") return null
  return { id, body, htmlUrl }
}

/**
 * Prepend the marker if the caller's body does not already contain it. Users can pass
 * a body that embeds their own marker (rare — mostly for tests), which is preserved.
 */
export function ensureMarker(body: string, marker: string): string {
  if (body.includes(marker)) return body
  return `${marker}${MARKER_SEPARATOR}${body}`
}
