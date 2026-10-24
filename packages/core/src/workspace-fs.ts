import { readFile, stat } from "node:fs/promises"
import { stripUtf8Bom } from "./codepoints"
import { CoreError } from "./errors"
import { describeThrown, isVanishedFile } from "./scan/faults"

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err: unknown) {
    if (isVanishedFile(err)) return false
    throw err
  }
}

export async function readJson(path: string): Promise<unknown> {
  return parseManifestJson(await readFile(path, "utf8"), path)
}

export function parseManifestJson(text: string, path: string): unknown {
  const body = stripUtf8Bom(text)
  try {
    return JSON.parse(body)
  } catch (cause) {
    throw new CoreError(
      `Failed to parse JSON at ${path}: ${describeJsonFailure(body, cause)}`,
      { code: "workspace-manifest-malformed", value: path },
      { cause },
    )
  }
}

// An editor hides a second mark, and the parser's message quotes it as the invisible character.
function describeJsonFailure(body: string, cause: unknown): string {
  if (stripUtf8Bom(body) !== body) {
    return "it opens with more than one byte order mark (U+FEFF), and only one is read past"
  }
  return describeThrown(cause)
}
