import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Absolute path to the checked-in `fixtures/nestjs-billing` project. Resolved by walking
 * up from this file (`packages/e2e-integration/src/fixture.ts`) to the package root and
 * then diving into `fixtures/`. Doing the resolution here instead of at the call site
 * keeps the tests portable — Vitest, tsc, and future tooling can import this without
 * knowing where they live relative to the package.
 */
export function fixtureRoot(): string {
  const here = fileURLToPath(import.meta.url)
  const packageRoot = resolve(dirname(here), "..")
  return resolve(packageRoot, "fixtures", "nestjs-billing")
}

/**
 * Copy the fixture into a fresh tmpdir so each test gets a mutable sandbox. The caller
 * receives the sandbox path plus a `cleanup` thunk that unlinks it. Tests are expected
 * to `finally { await cleanup() }` — a leaked sandbox in `%TEMP%` is a nuisance but not
 * fatal, so the assertion path stays uncluttered by extra teardown machinery.
 */
export async function checkoutFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const parent = await mkdtemp(resolve(tmpdir(), "aburi-e2e-"))
  const root = resolve(parent, "nestjs-billing")
  await mkdir(root, { recursive: true })
  await cp(fixtureRoot(), root, { recursive: true })
  return {
    root,
    cleanup: async () => {
      await rm(parent, { recursive: true, force: true })
    },
  }
}
