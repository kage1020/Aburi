import { execFile } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const isWindows = process.platform === "win32"
const npmCommand = isWindows ? "npm.cmd" : "npm"

/** Repository root, four directories up from `packages/e2e-integration/src`. */
export const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))

export interface PackedPackage {
  name: string
  directory: string
  /** Paths as they appear inside the tarball, relative to its `package/` prefix. */
  paths: readonly string[]
}

/**
 * Every workspace package that `changeset publish` would push to npm, with the file list
 * `npm pack` would put in each tarball.
 *
 * `--dry-run` builds the same list the real pack does — it reads `files`, the root
 * `.gitignore` is deliberately not consulted (npm-packlist only reads ignore files inside
 * the package directory), so a gitignored-but-published directory like
 * `lang-typescript/wasm` shows up here exactly as a consumer would receive it.
 */
export async function packPublishedPackages(): Promise<PackedPackage[]> {
  const packagesDir = join(repoRoot, "packages")
  const candidates = readdirSync(packagesDir).filter((name) => {
    const manifest = join(packagesDir, name, "package.json")
    try {
      return JSON.parse(readFileSync(manifest, "utf8")).private !== true
    } catch {
      return false
    }
  })

  return Promise.all(
    candidates.map(async (name) => {
      const directory = join(packagesDir, name)
      const { stdout } = await execFileAsync(npmCommand, ["pack", "--dry-run", "--json"], {
        cwd: directory,
        maxBuffer: 32 * 1024 * 1024,
        // On Windows npm is `npm.cmd`, which Node refuses to spawn without a shell.
        shell: isWindows,
      })
      const [packed] = JSON.parse(stdout) as [{ name: string; files: { path: string }[] }]
      return {
        name: packed.name,
        directory,
        // npm reports posix separators; normalise anyway so assertions read the same on
        // every platform.
        paths: packed.files.map((file) => file.path.replaceAll("\\", "/")),
      }
    }),
  )
}
