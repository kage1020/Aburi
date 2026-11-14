import { describe, expect, it } from "vitest"
import { pageHead } from "../.vitepress/head"

function linkHref(head: ReturnType<typeof pageHead>, rel: string) {
  return head.find(([tag, attrs]) => tag === "link" && attrs.rel === rel)?.[1].href
}

function metaContent(head: ReturnType<typeof pageHead>, property: string) {
  return head.find(([tag, attrs]) => tag === "meta" && attrs.property === property)?.[1].content
}

function jsonLd(head: ReturnType<typeof pageHead>) {
  return head
    .filter(([tag, attrs]) => tag === "script" && attrs.type === "application/ld+json")
    .map(([, , content]) => JSON.parse(content ?? ""))
}

describe("pageHead", () => {
  it.each([
    ["index.md", "https://aburi.dev/"],
    ["guide/page.md", "https://aburi.dev/guide/page"],
    ["section/index.md", "https://aburi.dev/section/"],
    ["section/generated-slug.md", "https://aburi.dev/section/generated-slug"],
  ])("gives %s the canonical URL %s, shared by og:url", (relativePath, url) => {
    const head = pageHead(relativePath)
    expect(linkHref(head, "canonical")).toBe(url)
    expect(metaContent(head, "og:url")).toBe(url)
  })

  it("gives the not-found page no canonical URL", () => {
    const head = pageHead("404.md")
    expect(linkHref(head, "canonical")).toBeUndefined()
    expect(metaContent(head, "og:url")).toBeUndefined()
  })

  it("describes the home page as a SoftwareApplication", () => {
    const [data, ...rest] = jsonLd(pageHead("index.md"))
    expect(rest).toEqual([])
    expect(data).toMatchObject({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Aburi",
      url: "https://aburi.dev/",
      applicationCategory: "DeveloperApplication",
      offers: { "@type": "Offer", price: "0" },
    })
    expect(data.sameAs).toContain("https://github.com/aburi-dev/Aburi")
    expect(data.description).toEqual(expect.any(String))
    expect(data.keywords).toEqual(expect.any(String))
  })

  it("adds structured data to the home page only", () => {
    expect(jsonLd(pageHead("guide/page.md"))).toEqual([])
  })
})
