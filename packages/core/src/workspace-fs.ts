import { readFile, stat } from "node:fs/promises"
import { CoreError } from "./errors"
import { isVanishedFile } from "./scan/faults"

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
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new CoreError(
      `Failed to parse JSON at ${path}`,
      { code: "workspace-manifest-malformed", value: path },
      { cause },
    )
  }
}
