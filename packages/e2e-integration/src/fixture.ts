import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_FIXTURE = "nestjs-billing"

/**
 * Absolute path to a checked-in fixture project under `packages/e2e-integration/fixtures/`.
 * Defaults to `nestjs-billing` (the workhorse used by scenarios A–D); other fixtures pass
 * their directory name explicitly. Resolution walks up from this file to the package root
 * so tests remain portable across Vitest, tsc, and any future tooling.
 */
export function fixtureRoot(name: string = DEFAULT_FIXTURE): string {
  const here = fileURLToPath(import.meta.url)
  const packageRoot = resolve(dirname(here), "..")
  return resolve(packageRoot, "fixtures", name)
}

/**
 * Copy a fixture into a fresh tmpdir so each test gets a mutable sandbox. The caller
 * receives the sandbox path plus a `cleanup` thunk that unlinks it. Tests are expected
 * to `finally { await cleanup() }` — a leaked sandbox in `%TEMP%` is a nuisance but not
 * fatal, so the assertion path stays uncluttered by extra teardown machinery.
 *
 * The fixture argument selects which directory under `fixtures/` to copy; when omitted
 * the workhorse `nestjs-billing` fixture is used.
 */
export async function checkoutFixture(
  name: string = DEFAULT_FIXTURE,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const parent = await mkdtemp(resolve(tmpdir(), "aburi-e2e-"))
  const root = resolve(parent, name)
  await mkdir(root, { recursive: true })
  await cp(fixtureRoot(name), root, { recursive: true })
  return {
    root,
    cleanup: async () => {
      await rm(parent, { recursive: true, force: true })
    },
  }
}
