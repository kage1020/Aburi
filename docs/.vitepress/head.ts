import type { HeadConfig } from "vitepress"

export const SITE = "https://aburi.dev"
export const REPOSITORY = "https://github.com/aburi-dev/Aburi"
export const DESCRIPTION =
  "Semantic IR extraction for high-level code review — read PRs at the level of business logic, not raw diffs."

const SOFTWARE_APPLICATION = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Aburi",
  url: `${SITE}/`,
  description: DESCRIPTION,
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "Code review",
  operatingSystem: "Linux, macOS, Windows",
  keywords: "semantic code review, code review, pull request, CI, static analysis",
  license: "https://www.apache.org/licenses/LICENSE-2.0",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  installUrl: `${SITE}/guide/getting-started`,
  downloadUrl: "https://www.npmjs.com/package/@aburi/cli",
  softwareHelp: { "@type": "WebPage", url: `${SITE}/guide/what-is-aburi` },
  author: { "@type": "Person", name: "kage1020", url: "https://github.com/kage1020" },
  sameAs: [REPOSITORY, "https://www.npmjs.com/package/@aburi/cli"],
}

export function pageHead(relativePath: string): HeadConfig[] {
  const url = canonicalUrl(relativePath)
  if (url === undefined) return []
  const head: HeadConfig[] = [
    ["link", { rel: "canonical", href: url }],
    ["meta", { property: "og:url", content: url }],
  ]
  if (relativePath === "index.md") {
    head.push(["script", { type: "application/ld+json" }, JSON.stringify(SOFTWARE_APPLICATION)])
  }
  return head
}

// Matches the URLs the sitemap lists under `cleanUrls`: no `.html`, and an index page as its directory.
function canonicalUrl(relativePath: string): string | undefined {
  if (relativePath === "404.md") return undefined
  const page = relativePath.replace(/\.md$/, "").replace(/(^|\/)index$/, "$1")
  return `${SITE}/${page}`
}
