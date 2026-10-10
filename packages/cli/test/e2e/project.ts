import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ScanResult, ServerFactory } from "@aburi/core"
import { nestEffectsPlugin } from "@aburi/effects-nest"
import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { type PluginLineup, type ScanExtras, scanWith } from "@aburi/test-harness"
import type { Component, Config } from "@aburi/types"
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest"

const DEFAULT_PROJECT = "nestjs-billing"

export function fixtureRoot(name: string = DEFAULT_PROJECT): string {
  return fileURLToPath(new URL(`./projects/${name}`, import.meta.url))
}

export interface FixtureCheckout {
  /** Absolute path of the copy; only meaningful inside a test or hook. */
  readonly root: string
}

/** A copy of `projects/<name>` under the OS temp dir, fresh per test or per file. */
export function useFixtureCheckout(
  name: string = DEFAULT_PROJECT,
  scope: "each" | "all" = "each",
): FixtureCheckout {
  let parent = ""
  let root = ""

  const setup = async () => {
    parent = await mkdtemp(join(tmpdir(), "aburi-e2e-"))
    root = join(parent, name)
    await mkdir(root, { recursive: true })
    await cp(fixtureRoot(name), root, { recursive: true })
  }
  const teardown = async () => {
    await rm(parent, { recursive: true, force: true })
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

/** Plugins layered on top of `scanFixture`'s TypeScript + NestJS lineup. */
export type ScanFixturePluginOverlay = PluginLineup

/** `scanWith` for the NestJS projects: TypeScript, NestJS and Nest effects plus `overlay`. */
export function scanFixture(
  workspaceRoot: string,
  config: Config = {},
  overlay: ScanFixturePluginOverlay = {},
  components: readonly Component[] = [],
  lspServerFactory?: ServerFactory,
): Promise<ScanResult> {
  const lineup: PluginLineup = {
    languages: [langTypescriptPlugin, ...(overlay.languages ?? [])],
    frameworks: [nestjsFrameworkPlugin, ...(overlay.frameworks ?? [])],
    effects: [nestEffectsPlugin, ...(overlay.effects ?? [])],
  }
  const extras: ScanExtras =
    lspServerFactory === undefined ? { components } : { components, lspServerFactory }
  return scanWith(workspaceRoot, lineup, config, extras)
}
