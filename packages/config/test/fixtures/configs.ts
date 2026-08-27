import type { Config, FrameworkHint } from "@aburi/types"

const SCHEMA = "https://aburi.kage1020.com/schema/aburi.config.v1.json"

export function emptyConfig(): Config {
  return { $schema: SCHEMA }
}

export function withEffects(effects: string[]): Config {
  return { $schema: SCHEMA, effects }
}

export function withComponents(ids: string[]): Config {
  return {
    $schema: SCHEMA,
    components: ids.map((id) => ({ id, roots: [`apps/${id}`] })),
  }
}

export function withHints(...hints: FrameworkHint[]): Config {
  return { $schema: SCHEMA, frameworkHints: hints }
}

export function hint(name: string, partial: Partial<FrameworkHint> = {}): FrameworkHint {
  return { name, ...partial }
}
