import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { listExamples, PACKAGE_ROOT } from "./examples"
import { renderExample } from "./render"

const out = join(PACKAGE_ROOT, "dist")
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const index = []
for (const dir of await listExamples()) {
  const { slug, title, summary, page } = await renderExample(dir)
  await writeFile(join(out, `${slug}.md`), `${page}\n`, "utf8")
  index.push({ slug, title, summary })
}
await writeFile(join(out, "showcase.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8")
