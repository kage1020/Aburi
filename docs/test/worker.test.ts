import { describe, expect, it } from "vitest"
import worker from "../worker/index"

type Asset = { body: string; type: string; headers?: Record<string, string> }

const SITE: Record<string, Asset> = {
  "/": { body: "<h1>Home</h1>", type: "text/html; charset=utf-8" },
  "/llms.txt": { body: "# Aburi\n\n> overview", type: "text/plain; charset=utf-8" },
  "/guide/page": { body: "<h1>Page</h1>", type: "text/html; charset=utf-8" },
  "/guide/page.md": { body: "# Page\n\nbody", type: "text/markdown; charset=utf-8" },
  "/section/": { body: "<h1>Section</h1>", type: "text/html; charset=utf-8" },
  "/section.md": { body: "# Section", type: "text/markdown; charset=utf-8" },
  "/html-only": { body: "<h1>No Markdown twin</h1>", type: "text/html; charset=utf-8" },
  "/brand/og.png": { body: "png", type: "image/png" },
  "/varied": {
    body: "<h1>Varied</h1>",
    type: "text/html; charset=utf-8",
    headers: { Vary: "Accept-Encoding" },
  },
}

const NOT_FOUND_PAGE = "<h1>404 page</h1>"

function assetsOf(site: Record<string, Asset>) {
  const requested: string[] = []
  return {
    requested,
    fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url)
      requested.push(pathname)
      const asset = site[pathname]
      const body = request.method === "HEAD" ? null : (asset?.body ?? NOT_FOUND_PAGE)
      if (asset === undefined) {
        return Promise.resolve(
          new Response(body, {
            status: 404,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
        )
      }
      const etag = `"${pathname}"`
      const headers = { "Content-Type": asset.type, ETag: etag, ...asset.headers }
      if (request.headers.get("If-None-Match") === etag) {
        return Promise.resolve(new Response(null, { status: 304, headers }))
      }
      return Promise.resolve(new Response(body, { headers }))
    },
  }
}

function get(path: string, accept?: string, method = "GET", extra: Record<string, string> = {}) {
  const assets = assetsOf(SITE)
  const headers = accept === undefined ? extra : { ...extra, Accept: accept }
  const request = new Request(`https://aburi.dev${path}`, { method, headers })
  return { response: worker.fetch(request, { ASSETS: assets }), assets }
}

const MARKDOWN = "text/markdown"

describe("a request that asks for Markdown", () => {
  it("is answered at the site root with the llms.txt overview", async () => {
    const response = await get("/", MARKDOWN).response
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8")
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe("# Aburi\n\n> overview")
  })

  it.each([
    ["/guide/page", "# Page\n\nbody"],
    ["/guide/page.html", "# Page\n\nbody"],
    ["/guide/page?tab=1", "# Page\n\nbody"],
    ["/section/", "# Section"],
  ])("for %s is answered with the page's Markdown twin", async (path, markdown) => {
    const response = await get(path, MARKDOWN).response
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8")
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe(markdown)
  })

  it("for a page with no Markdown twin falls back to the HTML page", async () => {
    const response = await get("/html-only", MARKDOWN).response
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe("<h1>No Markdown twin</h1>")
  })

  it("for a path that does not exist is a 404 in Markdown pointing at the site's indexes", async () => {
    const response = await get("/no/such/page", MARKDOWN).response
    expect(response.status).toBe(404)
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8")
    expect(response.headers.get("Vary")).toBe("Accept")
    const body = await response.text()
    expect(body).toContain("/no/such/page")
    expect(body).toContain("https://aburi.dev/llms.txt")
    expect(body).toContain("https://aburi.dev/sitemap.xml")
  })

  it("by HEAD carries the Markdown headers and no body", async () => {
    const response = await get("/guide/page", MARKDOWN, "HEAD").response
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8")
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe("")
  })

  it("revalidating its cached copy is answered 304 with the Markdown headers", async () => {
    const response = await get("/guide/page", MARKDOWN, "GET", {
      "If-None-Match": '"/guide/page.md"',
    }).response
    expect(response.status).toBe(304)
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8")
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe("")
  })

  it.each([
    ["/brand/og.png", "image/png"],
    ["/guide/page.md", "text/markdown; charset=utf-8"],
  ])("for the file %s is answered with that file", async (path, type) => {
    const response = await get(path, MARKDOWN).response
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe(type)
  })
})

describe("the Accept header", () => {
  it.each([
    "text/markdown",
    "text/markdown, text/html",
    "text/html, text/markdown",
    "text/html;q=0.5, text/markdown",
    "text/plain, text/markdown;q=0.9, */*;q=0.1",
    "TEXT/Markdown ; q=1",
  ])("%j selects Markdown", async (accept) => {
    const response = await get("/guide/page", accept).response
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8")
  })

  it.each([
    [undefined],
    ["*/*"],
    ["text/*"],
    ["text/html"],
    ["text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8"],
    ["text/markdown;q=0"],
    ["text/html, text/markdown;q=0.9"],
    ["text/markdown;q=0.5, */*"],
  ])("%j keeps the HTML page", async (accept) => {
    const response = await get("/guide/page", accept).response
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
    expect(await response.text()).toBe("<h1>Page</h1>")
  })
})

describe("a request for HTML", () => {
  it("is answered with the page and a Vary on Accept", async () => {
    const response = await get("/guide/page", "text/html").response
    expect(response.status).toBe(200)
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe("<h1>Page</h1>")
  })

  it("for a path that does not exist keeps the site's 404 page", async () => {
    const response = await get("/no/such/page", "text/html").response
    expect(response.status).toBe(404)
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe(NOT_FOUND_PAGE)
  })

  it("keeps a Vary the asset already carries", async () => {
    const response = await get("/varied", "text/html").response
    expect(response.headers.get("Vary")).toBe("Accept-Encoding, Accept")
  })

  it("never asks for a Markdown twin", async () => {
    const { response, assets } = get("/guide/page", "text/html")
    await response
    expect(assets.requested).toEqual(["/guide/page"])
  })
})

describe("a request that is neither GET nor HEAD", () => {
  it("is passed to the assets as it came", async () => {
    const { response, assets } = get("/guide/page", MARKDOWN, "POST")
    const answered = await response
    expect(answered.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
    expect(answered.headers.get("Vary")).toBeNull()
    expect(assets.requested).toEqual(["/guide/page"])
  })
})
