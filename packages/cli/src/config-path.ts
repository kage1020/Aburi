import type { AburiEnv } from "./env"

export function resolveConfigPath(cliFlag: string | undefined, env: AburiEnv): string | undefined {
  if (cliFlag !== undefined && cliFlag.length > 0) return cliFlag
  return env.configPath ?? undefined
}
