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
    ["meta", { property: "og:title", content: "Aburi" }],
    [
      "meta",
      {
        property: "og:description",
        content: "Semantic IR extraction for high-level code review.",
      },
    ],
    ["meta", { property: "og:url", content: "https://aburi.kage1020.com" }],
  ],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/cli-reference" },
      { text: "Design", link: "/design/overview" },
      { text: "Roadmap", link: "/roadmap" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "What is Aburi?", link: "/guide/what-is-aburi" },
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "CI integration", link: "/guide/ci-integration" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI reference", link: "/cli-reference" },
          { text: "Plugin development", link: "/plugin-development" },
        ],
      },
      {
        text: "Design",
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
          { text: "Markdown projection", link: "/design/markdown-projection" },
          { text: "CLI spec", link: "/design/cli-spec" },
          { text: "Config", link: "/design/config" },
        ],
      },
      {
        text: "Project",
        items: [{ text: "Roadmap", link: "/roadmap" }],
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
