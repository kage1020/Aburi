import type { Config, FrameworkHint } from "@aburi/types"

export const CONFIG_SCHEMA = "https://aburi.kage1020.com/schema/aburi.config.v1.json"

export function withHints(...hints: FrameworkHint[]): Config {
  return { $schema: CONFIG_SCHEMA, frameworkHints: hints }
}

export function hint(name: string, partial: Partial<FrameworkHint> = {}): FrameworkHint {
  return { name, ...partial }
}
