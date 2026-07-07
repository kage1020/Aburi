import type { AburiEnv } from "./env"

/**
 * §11 — precedence: CLI flag > `ABURI_CONFIG` env > null (falls through to on-disk
 * discovery). The design's ordering is "CLI flag > env > config file" so a runtime
 * `--config` must dominate an environment variable set at the CI level.
 *
 * Consolidated here so every command routes through the same helper; before this shim
 * existed, only `scan` looked at the env and it did so with the wrong precedence
 * (spread-order gave env priority over the explicit flag).
 */
export function resolveConfigPath(cliFlag: string | undefined, env: AburiEnv): string | undefined {
  if (cliFlag !== undefined && cliFlag.length > 0) return cliFlag
  return env.configPath ?? undefined
}
