import { defineConfig } from "vitepress"

export default defineConfig({
  title: "Aburi",
  description:
    "Semantic IR extraction for high-level code review — read PRs at the level of business logic, not raw diffs.",
  lang: "en-US",
  lastUpdated: true,
  cleanUrls: true,
  sitemap: {
    hostname: "https://aburi.kage1020.com",
  },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["link", { rel: "icon", type: "image/png", sizes: "32x32", href: "/brand/favicon-32.png" }],
    ["link", { rel: "icon", type: "image/png", sizes: "16x16", href: "/brand/favicon-16.png" }],
    ["link", { rel: "apple-touch-icon", href: "/brand/apple-touch-icon.png" }],
    ["meta", { name: "theme-color", content: "#B87514" }],
    ["meta", { property: "og:title", content: "Aburi" }],
    [
      "meta",
      {
        property: "og:description",
        content: "Semantic IR extraction for high-level code review.",
      },
    ],
    ["meta", { property: "og:url", content: "https://aburi.kage1020.com" }],
    ["meta", { property: "og:image", content: "https://aburi.kage1020.com/brand/og.png" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: "https://aburi.kage1020.com/brand/og.png" }],
  ],
  themeConfig: {
    logo: { light: "/brand/mark.svg", dark: "/brand/mark-dark.svg", alt: "Aburi" },
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/cli" },
      { text: "Extend", link: "/extend/architecture" },
      { text: "Roadmap", link: "/roadmap" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "What is Aburi?", link: "/guide/what-is-aburi" },
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Reading the report", link: "/guide/reading-the-report" },
          { text: "Supported stacks", link: "/guide/supported-stacks" },
          { text: "Configuration", link: "/guide/configuration" },
          { text: "CI integration", link: "/guide/ci-integration" },
        ],
      },
      {
        text: "Reference",
        items: [{ text: "CLI", link: "/reference/cli" }],
      },
      {
        text: "Extend",
        items: [
          { text: "Architecture", link: "/extend/architecture" },
          { text: "Plugin development", link: "/extend/plugin-development" },
        ],
      },
      {
        text: "Project",
        items: [{ text: "Roadmap", link: "/roadmap" }],
      },
      {
        text: "Design notes",
        collapsed: true,
        items: [
          { text: "Overview", link: "/design/overview" },
          { text: "IR schema", link: "/design/ir-schema" },
          { text: "Language plugins", link: "/design/lang-plugin" },
          { text: "Effect plugins", link: "/design/effect-plugin" },
          { text: "Extension vocabulary", link: "/design/extension-vocab" },
          { text: "Fingerprints", link: "/design/fingerprint" },
          { text: "Component detection", link: "/design/component-detect" },
          { text: "Drop list", link: "/design/drop-list" },
          { text: "Diff algorithm", link: "/design/diff-algorithm" },
          { text: "Call resolution", link: "/design/call-resolution" },
          { text: "Effect propagation", link: "/design/effect-propagation" },
          { text: "Slice view", link: "/design/slice-view" },
          { text: "Markdown projection", link: "/design/markdown-projection" },
          { text: "CLI spec", link: "/design/cli-spec" },
          { text: "Config", link: "/design/config" },
          { text: "LSP enrichment", link: "/design/lsp-enrichment" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/kage1020/Aburi" }],
    search: { provider: "local" },
    outline: { level: [2, 3] },
    editLink: {
      pattern: "https://github.com/kage1020/Aburi/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 kage1020",
    },
  },
})
