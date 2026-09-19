import type { Logger } from "@aburi/types"

/** The `Logger` a pass falls back to when its caller supplied none. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
