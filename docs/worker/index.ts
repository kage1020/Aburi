export interface Assets {
  fetch(request: Request): Promise<Response>
}

export interface Env {
  ASSETS: Assets
}

const SITE = "https://aburi.dev"
const MARKDOWN_TYPE = "text/markdown; charset=utf-8"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return env.ASSETS.fetch(request)
    const url = new URL(request.url)
    const twin = markdownTwin(url.pathname)
    if (twin === undefined) return env.ASSETS.fetch(request)
    if (!prefersMarkdown(request.headers.get("Accept"))) {
      return varyOnAccept(await env.ASSETS.fetch(request))
    }

    const markdown = await env.ASSETS.fetch(new Request(new URL(twin, url), request))
    if (markdown.ok || markdown.status === 304) {
      const headers = new Headers(markdown.headers)
      headers.set("Content-Type", MARKDOWN_TYPE)
      return varyOnAccept(new Response(markdown.body, { status: markdown.status, headers }))
    }
    await markdown.body?.cancel()

    const page = await env.ASSETS.fetch(request)
    if (page.status !== 404) return varyOnAccept(page)
    await page.body?.cancel()
    return varyOnAccept(
      new Response(request.method === "HEAD" ? null : notFound(url.pathname), {
        status: 404,
        headers: { "Content-Type": MARKDOWN_TYPE },
      }),
    )
  },
}

// Built pages are published beside a Markdown copy: `/a/b` and `/a/` as `/a/b.md` and `/a.md`.
// Any other file is served as it is, so a path with an extension of its own has no twin.
function markdownTwin(pathname: string): string | undefined {
  if (pathname === "/") return "/llms.txt"
  const page = pathname.replace(/\/$/, "").replace(/\.html$/, "")
  if (/\.[^/]*$/.test(page)) return undefined
  return `${page}.md`
}

// Markdown is chosen only when it is named outright and ranked no lower than HTML, so browsers and
// `*/*` clients keep the HTML page.
function prefersMarkdown(accept: string | null): boolean {
  if (accept === null) return false
  const ranges = accept.split(",").flatMap((entry) => {
    const [range, ...params] = entry.split(";").map((part) => part.trim().toLowerCase())
    if (!range) return []
    const q = params.find((param) => param.startsWith("q="))
    return [{ range, q: q === undefined ? 1 : Number(q.slice(2)) || 0 }]
  })
  const quality = (type: string) => {
    const [major] = type.split("/")
    const match =
      ranges.find(({ range }) => range === type) ??
      ranges.find(({ range }) => range === `${major}/*`) ??
      ranges.find(({ range }) => range === "*/*")
    return match?.q ?? 0
  }
  const markdown = ranges.find(({ range }) => range === "text/markdown")?.q ?? 0
  return markdown > 0 && markdown >= quality("text/html")
}

function varyOnAccept(response: Response): Response {
  const varied = new Response(response.body, response)
  const vary = varied.headers.get("Vary")
  const named = vary?.split(",").some((field) => field.trim().toLowerCase() === "accept")
  if (!named) varied.headers.set("Vary", vary ? `${vary}, Accept` : "Accept")
  return varied
}

function notFound(pathname: string): string {
  return `# Page not found

Nothing is published at \`${pathname}\` on ${SITE}.

- [llms.txt](${SITE}/llms.txt) lists every page of the documentation, each as Markdown.
- [sitemap.xml](${SITE}/sitemap.xml) lists every page as HTML.
`
}
