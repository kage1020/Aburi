import { hasMatchingImport, matchesModuleOrSubpath } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_DRIZZLE_PLUGIN_NAME } from "./constants"

const isDrizzleModule = matchesModuleOrSubpath("drizzle-orm")

export function hasDrizzleImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_DRIZZLE_PLUGIN_NAME, filePath },
    isDrizzleModule,
  )
}
