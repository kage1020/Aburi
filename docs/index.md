---
layout: home

hero:
  name: Aburi
  text: Semantic IR extraction for high-level code review
  tagline: Read pull requests at the level of business logic, control flow, and module boundaries — not raw diffs.
  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: What is Aburi?
      link: /guide/what-is-aburi
    - theme: alt
      text: GitHub
      link: https://github.com/kage1020/Aburi

features:
  - icon: 🔍
    title: Static analysis, not an LLM judge
    details: Parses with tree-sitter, matches Symbols across revisions with a 5-stage semantic diff, and emits a deterministic JSON IR. Same input, same output — every time.
  - icon: 🧭
    title: Diffs that mean something
    details: A file rename with unchanged logic is `moved`, not `removed + added`. A new validation guard is `changed` with `logicChanged` — and CI can gate on exactly that.
  - icon: 🧹
    title: Boilerplate dropped, signal kept
    details: Interfaces, re-exports, and empty bodies are dropped from the diff so reviewers only see the changes that carry meaning.
  - icon: 🚦
    title: CI gates in one flag
    details: "`aburi diff main..HEAD --fail-on 'changed,removed:>5'` — exit code 3 trips your pipeline. A GitHub Action posts the Markdown report as a PR comment."
  - icon: 🧩
    title: Pluggable by design
    details: Language, framework, and effects plugins share a manifest contract with namespace ownership enforced at load time. TypeScript, NestJS, Next.js, and Prisma ship first-party.
  - icon: 📄
    title: One IR, many views
    details: Everything downstream of `aburi.ir.v1.json` is deterministically derived — workspace overview, per-component detail, PR diff, and per-Symbol explain views.
---
