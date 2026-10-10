import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export interface ShowcaseEntry {
  slug: string
  title: string
  summary: string
}

/** The pages `@aburi/examples` rendered at build time; build that package first. */
export function readShowcase(): ShowcaseEntry[] {
  return JSON.parse(readFileSync(showcaseFile("showcase.json"), "utf8")) as ShowcaseEntry[]
}

export function readShowcasePage(slug: string): string {
  return readFileSync(showcaseFile(`${slug}.md`), "utf8")
}

function showcaseFile(name: string): string {
  try {
    return require.resolve(`@aburi/examples/showcase/${name}`)
  } catch (cause) {
    throw new Error(
      `@aburi/examples has not rendered ${name}. Run \`pnpm turbo run build --filter=@aburi/docs^...\` first.`,
      { cause },
    )
  }
}
