/**
 * Hidden HTML marker embedded at the top of every comment we post. The upsert step
 * greps the PR comment stream for this exact string and treats a match as "this comment
 * belongs to us" — that is the whole reason we can update in place across pushes
 * instead of leaving a trail of one-comment-per-run.
 *
 * Keep this constant stable across releases: users' existing PR comments were posted
 * with the old value, and changing it now would orphan them. If the marker ever needs
 * to change, ship a migration step that also matches the previous value.
 */
export const ABURI_COMMENT_MARKER = "<!-- aburi:diff-comment -->"

/**
 * What {@link ensureMarker} puts between the marker and the body. Shared with the budget below
 * rather than spelled in both: the two are the same bytes, and a change to one that missed the
 * other would move the budget silently, in the direction of a body 65538 bytes long.
 */
const MARKER_SEPARATOR = "\n\n"

/**
 * GitHub's ceiling on an issue-comment body. A create or update carrying more is rejected with
 * a 422 and nothing is posted — there is no partial write to fall back on.
 */
export const GITHUB_COMMENT_MAX_BYTES = 65536

/**
 * What a report rendered for the default marker may weigh: the ceiling less that marker and its
 * separator. This is the number to render with — `aburi diff --max-bytes <n>`
 * (`markdown-projection.md` §6.4) drops whole sections to meet it — and the default
 * `scripts/resolve-max-bytes.mjs` holds.
 *
 * The action passes it on every run that writes Markdown, `comment: false` included, because
 * that is the mode a fork's pull request uses and its artefact is posted by another workflow
 * (`docs/design/github-action.md` §5.2). A caller naming its own `max-bytes` gets that instead,
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
  /**
   * Injected `fetch`. Kept explicit so tests can drive the flow with a fake without
   * touching the real network — the default is a thin binding to the runtime's global.
   */
  readonly fetch?: typeof globalThis.fetch
  /** Marker override. Defaults to {@link ABURI_COMMENT_MARKER}. */
  readonly marker?: string
}

export type UpsertOutcome =
  | { readonly action: "created"; readonly commentId: number; readonly url: string }
  | { readonly action: "updated"; readonly commentId: number; readonly url: string }
  | { readonly action: "unchanged"; readonly commentId: number; readonly url: string }

/**
 * Locate an existing marker comment on the PR and update it, or create a new one if
 * none exists. Returns `unchanged` when the current body already matches — that path
 * lets a re-run of the same workflow (e.g. someone re-triggered the action) be a
 * no-op instead of bumping the comment's `updated_at` and inflating notifications.
 *
 * The GitHub REST API uses the *issues* endpoint for PR-level comments (review
 * comments on specific lines are a different endpoint we intentionally do not touch).
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
  const apiBase = options.apiBase ?? "https://api.github.com"
  const fetchImpl = options.fetch ?? globalThis.fetch

  const existing = await findMarkerComment({
    ref: options.ref,
    marker,
    apiBase,
    token: options.token,
    fetchImpl,
  })

  if (existing !== null) {
    if (existing.body === bodyWithMarker) {
      return { action: "unchanged", commentId: existing.id, url: existing.htmlUrl }
    }
    const updated = await patchComment({
      ref: options.ref,
      commentId: existing.id,
      body: bodyWithMarker,
      apiBase,
      token: options.token,
      fetchImpl,
    })
    return { action: "updated", commentId: updated.id, url: updated.htmlUrl }
  }

  const created = await postComment({
    ref: options.ref,
    body: bodyWithMarker,
    apiBase,
    token: options.token,
    fetchImpl,
  })
  return { action: "created", commentId: created.id, url: created.htmlUrl }
}

interface StoredComment {
  readonly id: number
  readonly body: string
  readonly htmlUrl: string
}

interface FindArgs {
  readonly ref: PullRequestRef
  readonly marker: string
  readonly apiBase: string
  readonly token: string
  readonly fetchImpl: typeof globalThis.fetch
}

async function findMarkerComment(args: FindArgs): Promise<StoredComment | null> {
  const perPage = 100
  for (let page = 1; ; page++) {
    const url = buildApiUrl(
      args.apiBase,
      `repos/${args.ref.owner}/${args.ref.repo}/issues/${args.ref.pullNumber}/comments`,
    )
    url.searchParams.set("per_page", String(perPage))
    url.searchParams.set("page", String(page))
    const response = await args.fetchImpl(url, {
      method: "GET",
      headers: authHeaders(args.token),
    })
    if (!response.ok) {
      throw await githubError("list PR comments", response)
    }
    const rows = (await response.json()) as unknown
    if (!Array.isArray(rows)) {
      throw new Error(
        `GitHub returned a non-array response listing PR comments for #${args.ref.pullNumber}.`,
      )
    }
    for (const row of rows) {
      const parsed = parseComment(row)
      if (parsed?.body.includes(args.marker)) return parsed
    }
    if (rows.length < perPage) return null
  }
}

interface PostArgs {
  readonly ref: PullRequestRef
  readonly body: string
  readonly apiBase: string
  readonly token: string
  readonly fetchImpl: typeof globalThis.fetch
}

async function postComment(args: PostArgs): Promise<StoredComment> {
  const url = buildApiUrl(
    args.apiBase,
    `repos/${args.ref.owner}/${args.ref.repo}/issues/${args.ref.pullNumber}/comments`,
  )
  const response = await args.fetchImpl(url, {
    method: "POST",
    headers: { ...authHeaders(args.token), "content-type": "application/json" },
    body: JSON.stringify({ body: args.body }),
  })
  if (!response.ok) throw await githubError("create PR comment", response)
  const created = parseComment(await response.json())
  if (created === null) {
    throw new Error("GitHub returned a comment response without id/body/html_url fields.")
  }
  return created
}

interface PatchArgs {
  readonly ref: PullRequestRef
  readonly commentId: number
  readonly body: string
  readonly apiBase: string
  readonly token: string
  readonly fetchImpl: typeof globalThis.fetch
}

async function patchComment(args: PatchArgs): Promise<StoredComment> {
  const url = buildApiUrl(
    args.apiBase,
    `repos/${args.ref.owner}/${args.ref.repo}/issues/comments/${args.commentId}`,
  )
  const response = await args.fetchImpl(url, {
    method: "PATCH",
    headers: { ...authHeaders(args.token), "content-type": "application/json" },
    body: JSON.stringify({ body: args.body }),
  })
  if (!response.ok) throw await githubError("update PR comment", response)
  const updated = parseComment(await response.json())
  if (updated === null) {
    throw new Error("GitHub returned a comment response without id/body/html_url fields.")
  }
  return updated
}

/**
 * Build an absolute URL under the API base while preserving any base path (GitHub
 * Enterprise Server mounts the API under `/api/v3`). Using `new URL(absolute, base)`
 * would drop the base path whenever the second argument starts with a slash, so we
 * concatenate against a normalised base and let `URL` handle the rest.
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
