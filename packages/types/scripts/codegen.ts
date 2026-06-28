import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ENTRIES, generateAll, OUT_DIR } from "./codegen-lib"

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  const generated = await generateAll()
  for (const entry of ENTRIES) {
    const content = generated[entry.out]
    if (content === undefined) {
      throw new Error(`Internal: no content generated for ${entry.out}`)
    }
    await writeFile(join(OUT_DIR, entry.out), content, "utf8")
    console.log(`generated  ${entry.out.padEnd(12)} ← ${entry.schema}`)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
