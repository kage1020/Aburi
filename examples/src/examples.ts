import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url))

const NOT_EXAMPLES = new Set(["dist", "node_modules", "src", "test"])

/** Every example directory in this package, in name order. */
export async function listExamples(root: string = PACKAGE_ROOT): Promise<string[]> {
  const names: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || NOT_EXAMPLES.has(entry.name) || entry.name.startsWith(".")) continue
    if (!(await hasReadme(join(root, entry.name)))) {
      throw new Error(`${entry.name} is not an example: it has no README.md`)
    }
    names.push(entry.name)
  }
  if (names.length === 0) throw new Error(`no examples under ${root}`)
  return names.sort().map((name) => join(root, name))
}

async function hasReadme(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, "README.md"))).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
