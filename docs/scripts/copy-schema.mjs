import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Stage `schema/*.json` into the VitePress public directory so the documentation site
 * serves each schema at the URL it names as its own `$id`.
 *
 * Copied at build time rather than committed under `public/`, because a second copy in
 * the tree is a second thing to remember: the one in `schema/` is what `@aburi/types`
 * generates from and what the plugin loader validates against, and a stale duplicate
 * would advertise a contract the tool does not implement.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = resolve(HERE, "..")
const SCHEMA_DIR = resolve(DOCS_ROOT, "..", "schema")
const PUBLIC_DIR = join(DOCS_ROOT, "public", "schema")

/**
 * Where the built site is served from. Kept in step with `sitemap.hostname` in
 * `.vitepress/config.ts` and with the `routes[].pattern` in `wrangler.jsonc`.
 */
const SITE_ORIGIN = "https://aburi.kage1020.com"

const names = (await readdir(SCHEMA_DIR)).filter((name) => name.endsWith(".json")).sort()

if (names.length === 0) {
  throw new Error(`No schemas found in ${SCHEMA_DIR}`)
}

// A schema is only reachable through its `$id` if that `$id` is the address it ends up
// at. Checking here fails the docs build on the mismatch rather than publishing a
// document whose own identifier points somewhere else — which is exactly the state the
// schemas shipped in while they claimed a host this project does not own.
for (const name of names) {
  const raw = await readFile(join(SCHEMA_DIR, name), "utf8")
  const { $id } = JSON.parse(raw)
  const expected = `${SITE_ORIGIN}/schema/${name}`
  if ($id !== expected) {
    throw new Error(`${name}: $id is ${JSON.stringify($id)}, but it is served at ${expected}`)
  }
}

// Rebuilt from scratch so a schema deleted upstream stops being served here too.
await rm(PUBLIC_DIR, { recursive: true, force: true })
await mkdir(PUBLIC_DIR, { recursive: true })
for (const name of names) {
  await cp(join(SCHEMA_DIR, name), join(PUBLIC_DIR, name))
}

console.log(`staged ${names.length} schema(s) for ${SITE_ORIGIN}/schema/: ${names.join(", ")}`)
