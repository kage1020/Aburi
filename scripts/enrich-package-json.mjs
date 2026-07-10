#!/usr/bin/env node
// One-shot script used during the WI-18 release-prep PR to add
// repository.directory / author / homepage / bugs to every publishable
// package.json under packages/*. Kept in-tree as documentation of the shape
// convention rather than as a periodic tool — the release workflow does not
// invoke it. Re-run only when adding a new publishable package.
//
// Contract:
//   - Skips private packages (private === true).
//   - Preserves any pre-existing metadata field the package.json already has;
//     the `??` fallbacks below only fill gaps.
//   - Names the file that failed on parse error, so a corrupt package.json
//     stops the whole pass with a locatable message.
//   - Reports the number of packages touched (and warns loudly on 0) so an
//     accidental scope-wide misconfiguration cannot pass as a silent no-op.

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

let touched = 0
let skippedPrivate = 0

for (const entry of entries) {
  if (!entry.isDirectory()) continue
  const pkgPath = resolve(packagesDir, entry.name, "package.json")

  let pkg
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"))
  } catch (error) {
    process.stderr.write(`ERROR: failed to parse ${pkgPath}: ${error.message}\n`)
    process.exit(1)
  }

  if (pkg.private === true) {
    process.stdout.write(`skipped (private): packages/${entry.name}\n`)
    skippedPrivate += 1
    continue
  }

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

  // Field order convention borrowed from other pnpm/changesets monorepos:
  // name / version / description on top, metadata next, runtime shape after,
  // scripts/deps at the bottom. Nothing enforces this order at parse time —
  // it is a readability choice for reviewers, not a tool requirement.
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
  touched += 1
}

process.stdout.write(`\n${touched} package.json touched, ${skippedPrivate} skipped (private).\n`)
if (touched === 0) {
  process.stderr.write(
    "WARNING: no packages were touched. Check that packages/* still contains publishable entries.\n",
  )
  process.exit(1)
}
