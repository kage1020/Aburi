---
layout: home

hero:
  name: Aburi
  text: See what a pull request did
  tagline: Aburi reads a change the way a senior reviewer does. New endpoints, new database writes, deleted logic. It writes the result as Markdown your CI can gate on.
  image:
    light: /brand/mark.svg
    dark: /brand/mark-dark.svg
    alt: Aburi
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What is Aburi?
      link: /guide/what-is-aburi
    - theme: alt
      text: GitHub
      link: https://github.com/kage1020/Aburi

features:
  - icon: 🔍
    title: A diff that survives refactoring
    details: Move a file, rename a variable, reformat a body, and Aburi still recognises the same code. Only the changes that alter behaviour reach the report.
  - icon: 🚦
    title: One flag makes it a CI gate
    details: Add --fail-on removed and your pipeline fails when a symbol disappears. The bundled GitHub Action posts the report as a pull request comment.
  - icon: 🧩
    title: Knows your framework
    details: Aburi recognises NestJS routes, Next.js App Router files, Express handlers, React components, and Prisma and Drizzle queries out of the box.
  - icon: 🔁
    title: Deterministic, no LLM
    details: Static analysis with tree-sitter. The same commit always produces the same report, so a difference between two runs is a real difference.
---
