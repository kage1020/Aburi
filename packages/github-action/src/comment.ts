export const ABURI_COMMENT_MARKER = "<!-- aburi:diff-comment -->"

/** What {@link ensureMarker} puts between the marker and the body; the budget below counts it. */
const MARKER_SEPARATOR = "\n\n"

export const GITHUB_COMMENT_MAX_BYTES = 65536

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

export async function upsertPullRequestComment(options: UpsertOptions): Promise<UpsertOutcome> {
  const marker = options.marker ?? ABURI_COMMENT_MARKER
  const bodyWithMarker = ensureMarker(options.body, marker)
  const size = Buffer.byteLength(bodyWithMarker, "utf8")
  if (size > GITHUB_COMMENT_MAX_BYTES) {
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

/** A comment as the list returns it, with the author that decides whose it is. */
interface ListedComment extends StoredComment {
  readonly author: { readonly login: string; readonly isBot: boolean }
}

interface ApiContext {
  readonly ref: PullRequestRef
  readonly apiBase: string
  readonly token: string
  readonly fetch: typeof globalThis.fetch
}

function commentsPath(ref: PullRequestRef): string {
  return `repos/${ref.owner}/${ref.repo}/issues/${ref.pullNumber}/comments`
}

/** The refusal an installation token gets from `GET /user` (see {@link posterLogin}). */
const INTEGRATION_REFUSAL = "Resource not accessible by integration"

async function posterLogin(api: ApiContext): Promise<string | null> {
  const response = await api.fetch(buildApiUrl(api.apiBase, "user"), {
    method: "GET",
    headers: authHeaders(api.token),
  })
  if (response.status === 403) {
    const message = (
      (await response
        .clone()
        .json()
        .catch(() => null)) as { message?: unknown } | null
    )?.message
    if (message === INTEGRATION_REFUSAL) return null
  }
  if (!response.ok) throw await githubError("identify the token's user", response)
  const login = ((await response.json()) as { login?: unknown } | null)?.login
  if (typeof login !== "string" || login === "") {
    throw new Error("GitHub returned a user without a login for this token.")
  }
  return login
}

function isOwnComment(comment: ListedComment, marker: string, self: string | null): boolean {
  if (!comment.body.startsWith(marker)) return false
  return self === null ? comment.author.isBot : comment.author.login === self
}

async function findMarkerComment(api: ApiContext, marker: string): Promise<ListedComment | null> {
  const perPage = 100
  let self: { readonly login: string | null } | undefined
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
      const parsed = parseListedComment(row)
      if (!parsed?.body.startsWith(marker)) continue
      self ??= { login: await posterLogin(api) }
      if (isOwnComment(parsed, marker, self.login)) return parsed
    }
    if (rows.length < perPage) return null
  }
}

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

function parseListedComment(row: unknown): ListedComment | null {
  const comment = parseComment(row)
  if (comment === null) return null
  // An unreadable author is an unreadable row, as in the script, not a stranger's comment.
  const user = (row as { user?: unknown }).user
  if (typeof user !== "object" || user === null) return null
  const login = (user as { login?: unknown }).login
  if (typeof login !== "string") return null
  return { ...comment, author: { login, isBot: (user as { type?: unknown }).type === "Bot" } }
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

export function ensureMarker(body: string, marker: string): string {
  if (body.startsWith(marker)) return body
  return `${marker}${MARKER_SEPARATOR}${body}`
}
