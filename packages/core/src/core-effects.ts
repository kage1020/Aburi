export interface CoreEffect {
  readonly id: string
  readonly description: string
}

/** The core effect vocabulary, in the order the IR schema lists it. No plugin owns these. */
export const CORE_EFFECTS: readonly CoreEffect[] = [
  { id: "db.read", description: "Database read" },
  { id: "db.write", description: "Database write" },
  { id: "db.transaction", description: "Database transaction" },
  { id: "db.migration", description: "Database schema migration" },
  { id: "network.http", description: "HTTP request" },
  { id: "network.ws", description: "WebSocket connection or message" },
  { id: "network.rpc", description: "Remote procedure call" },
  { id: "queue.publish", description: "Message published to a queue" },
  { id: "queue.consume", description: "Message consumed from a queue" },
  { id: "event.publish", description: "Event emitted" },
  { id: "event.subscribe", description: "Event listener registered" },
  { id: "fs.read", description: "File system read" },
  { id: "fs.write", description: "File system write" },
  { id: "state.mutate", description: "Shared state mutated" },
  { id: "collection.mutate", description: "Collection mutated in place" },
  { id: "time.now", description: "Current time read" },
  { id: "time.timer", description: "Timer scheduled" },
  { id: "random", description: "Random value drawn" },
  { id: "env.read", description: "Environment variable read" },
  { id: "env.write", description: "Environment variable written" },
  { id: "process.exit", description: "Process exit" },
  { id: "process.signal", description: "Process signal sent or handled" },
]

const CORE_EFFECT_IDS: ReadonlySet<string> = new Set(CORE_EFFECTS.map((effect) => effect.id))

/** Whether `id` is one of the core effect ids, which no plugin owns and any may emit. */
export function isCoreEffectId(id: string): boolean {
  return CORE_EFFECT_IDS.has(id)
}
