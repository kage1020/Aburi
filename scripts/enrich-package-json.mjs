#!/usr/bin/env node
// One-shot script: enrich every publishable package.json under packages/* with
// the metadata npm needs to route back to the correct monorepo subdirectory
// (repository.directory), plus author / homepage / bugs. Idempotent — reading
// an already-enriched package.json is a no-op. Not part of the CI pipeline;
// invoke once from the release-prep PR.

import { readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoUrl = "git+https://github.com/kage1020/Aburi.git"
const homepageBase = "https://github.com/kage1020/Aburi/tree/main"
const bugsUrl = "https://github.com/kage1020/Aburi/issues"

const here = fileURLToPath(import.meta.url)
const root = resolve(dirname(here), "..")
const packagesDir = resolve(root, "packages")
const entries = await readdir(packagesDir, { withFileTypes: true })

for (const entry of entries) {
  if (!entry.isDirectory()) continue
  const pkgPath = resolve(packagesDir, entry.name, "package.json")
  const raw = await readFile(pkgPath, "utf8")
  const pkg = JSON.parse(raw)
  if (pkg.private === true) continue

  const relative = `packages/${entry.name}`
  const enriched = {
    ...pkg,
    author: pkg.author ?? "kage1020",
    homepage: pkg.homepage ?? `${homepageBase}/${relative}#readme`,
    bugs: pkg.bugs ?? { url: bugsUrl },
    repository: pkg.repository ?? {
      type: "git",
      url: repoUrl,
      directory: relative,
    },
  }

  // Preserve key order that changesets / npm expect: name, version, description,
  // then metadata, then the rest. JSON.stringify preserves insertion order.
  const ordered = {}
  const priority = [
    "name",
    "version",
    "description",
    "license",
    "author",
    "homepage",
    "bugs",
    "repository",
    "type",
    "main",
    "types",
    "bin",
    "exports",
    "files",
    "sideEffects",
    "publishConfig",
    "engines",
    "scripts",
    "dependencies",
    "peerDependencies",
    "devDependencies",
  ]
  for (const key of priority) {
    if (key in enriched) ordered[key] = enriched[key]
  }
  for (const key of Object.keys(enriched)) {
    if (!(key in ordered)) ordered[key] = enriched[key]
  }

  await writeFile(pkgPath, `${JSON.stringify(ordered, null, 2)}\n`, "utf8")
  process.stdout.write(`updated ${relative}/package.json\n`)
}
