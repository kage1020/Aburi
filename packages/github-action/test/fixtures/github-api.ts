import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import {
  ABURI_COMMENT_MARKER,
  type UpsertOptions,
  type UpsertOutcome,
  upsertPullRequestComment,
} from "../../src/comment"

export interface RecordedRequest {
  readonly method: string
  /** Path and query, as the server received them. */
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface Reply {
  readonly status?: number
  readonly json?: unknown
  readonly text?: string
}

/** What `GET /user` answers an installation token, such as the default `github.token`. */
const INSTALLATION_TOKEN_REFUSAL: Reply = {
  status: 403,
  json: { message: "Resource not accessible by integration" },
}

export interface FakeApi {
  /** Every request but `GET /user`. */
  readonly replies: (request: RecordedRequest) => Reply
  /** `GET /user`: who the token says it is. */
  readonly user?: Reply
}

/** Serve `api` on a local port for the length of `run`, recording every request it gets. */
export async function withApi(
  api: FakeApi,
  run: (base: string, requests: readonly RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = []
  const server = createServer(async (req, res) => {
    const request: RecordedRequest = {
      method: req.method ?? "",
      path: req.url ?? "",
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([name, value]) => [name, String(value)]),
      ),
      body: await readBody(req),
    }
    requests.push(request)
    const reply = request.path.endsWith("/user")
      ? (api.user ?? INSTALLATION_TOKEN_REFUSAL)
      : api.replies(request)
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" })
    res.end(reply.text ?? JSON.stringify(reply.json ?? {}))
  })
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening))
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`, requests)
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()))
  }
}

/** A base URL nothing listens on, so every request to it is refused. */
export async function refusingBase(): Promise<string> {
  const server = createServer()
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((closed) => server.close(() => closed()))
  return `http://127.0.0.1:${port}`
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let raw = ""
    req.on("data", (chunk) => {
      raw += String(chunk)
    })
    req.on("end", () => done(raw))
  })
}

/**
 * Answers the comment list page by page from `pages`, an empty page past the last, and every
 * write with `written`.
 */
export function listing(pages: readonly (readonly unknown[])[], written: Reply = created(1)) {
  return (request: RecordedRequest): Reply => {
    if (request.method !== "GET") return written
    const page = Number(new URL(request.path, "http://localhost").searchParams.get("page"))
    return { json: pages[page - 1] ?? [] }
  }
}

/** The account the default `github.token` posts as. */
export const ACTIONS_BOT = { login: "github-actions[bot]", type: "Bot" }

export function comment(
  id: number,
  body: string,
  user: { login: string; type: string } = ACTIONS_BOT,
) {
  return { id, body, html_url: `https://github.example/c/${id}`, user }
}

/** `body` as Aburi posts it: opening with the marker. */
export function marked(body: string): string {
  return `${ABURI_COMMENT_MARKER}\n\n${body}`
}

/** A write's reply: comment `id`, created. */
export function created(id: number): Reply {
  return { status: 201, json: comment(id, "x") }
}

/** A write's reply: comment `id`, updated. */
export function updated(id: number): Reply {
  return { json: comment(id, "patched") }
}

export function writesOf(requests: readonly RecordedRequest[]): string[] {
  return requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`)
}

export function postedBody(requests: readonly RecordedRequest[]): string {
  const write = requests.find((r) => r.method !== "GET")
  return (JSON.parse(write?.body ?? "{}") as { body: string }).body
}

export const PULL_REQUEST = { owner: "kage1020", repo: "Aburi", pullNumber: 42 }

/** `upsertPullRequestComment` for the report `body`, against the fake API at `base`. */
export function upsertAgainst(
  base: string,
  body: string,
  options: Partial<UpsertOptions> = {},
): Promise<UpsertOutcome> {
  return upsertPullRequestComment({
    ref: PULL_REQUEST,
    body,
    token: "secret-token",
    apiBase: base,
    ...options,
  })
}
