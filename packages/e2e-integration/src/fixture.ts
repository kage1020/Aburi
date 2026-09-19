import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest"

const DEFAULT_FIXTURE = "nestjs-billing"

/**
 * Absolute path to a checked-in fixture project under `packages/e2e-integration/fixtures/`.
 * Defaults to `nestjs-billing`, the workhorse used by scenarios A–D.
 */
export function fixtureRoot(name: string = DEFAULT_FIXTURE): string {
  const here = fileURLToPath(import.meta.url)
  const packageRoot = resolve(dirname(here), "..")
  return resolve(packageRoot, "fixtures", name)
}

/**
 * Copy a fixture into a fresh tmpdir so the test gets a mutable sandbox. Callers own the
 * `cleanup` thunk; prefer `useFixtureCheckout`, which wires it to the Vitest lifecycle.
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

export interface FixtureCheckout {
  /** Absolute path of the sandbox; only meaningful inside a test or hook. */
  readonly root: string
}

/**
 * A fixture checkout bound to the Vitest lifecycle. `"each"` (the default) gives every test
 * its own copy, which tests that mutate the fixture need; `"all"` shares one copy across the
 * file, for suites that only read it.
 */
export function useFixtureCheckout(
  name: string = DEFAULT_FIXTURE,
  scope: "each" | "all" = "each",
): FixtureCheckout {
  let root = ""
  let cleanup: (() => Promise<void>) | null = null

  const setup = async () => {
    const fixture = await checkoutFixture(name)
    root = fixture.root
    cleanup = fixture.cleanup
  }
  const teardown = async () => {
    await cleanup?.()
    cleanup = null
  }

  if (scope === "each") {
    beforeEach(setup)
    afterEach(teardown)
  } else {
    beforeAll(setup)
    afterAll(teardown)
  }

  return {
    get root() {
      return root
    },
  }
}
