import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = resolve(HERE, "..")
const SCHEMA_DIR = resolve(DOCS_ROOT, "..", "schema")
const PUBLIC_DIR = join(DOCS_ROOT, "public", "schema")

const SITE_ORIGIN = "https://aburi.kage1020.com"

const names = (await readdir(SCHEMA_DIR)).filter((name) => name.endsWith(".json")).sort()

if (names.length === 0) {
  throw new Error(`No schemas found in ${SCHEMA_DIR}`)
}

for (const name of names) {
  const raw = await readFile(join(SCHEMA_DIR, name), "utf8")
  const { $id } = JSON.parse(raw)
  const expected = `${SITE_ORIGIN}/schema/${name}`
  if ($id !== expected) {
    throw new Error(`${name}: $id is ${JSON.stringify($id)}, but it is served at ${expected}`)
  }
}

await rm(PUBLIC_DIR, { recursive: true, force: true })
await mkdir(PUBLIC_DIR, { recursive: true })
for (const name of names) {
  await cp(join(SCHEMA_DIR, name), join(PUBLIC_DIR, name))
}

console.log(`staged ${names.length} schema(s) for ${SITE_ORIGIN}/schema/: ${names.join(", ")}`)
