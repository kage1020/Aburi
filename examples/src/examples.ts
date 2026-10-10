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
    if ((await stat(join(root, entry.name, "README.md")).catch(() => null)) !== null) {
      names.push(entry.name)
    }
  }
  return names.sort().map((name) => join(root, name))
}
