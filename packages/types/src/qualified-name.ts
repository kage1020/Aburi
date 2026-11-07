/**
 * The segment of a qualified Symbol name that follows its last `::`, then its last `.`: the
 * `shortName` the api fingerprint hashes. An empty name, or one ending in a separator, gives `""`.
 */
export function lastSegment(name: string): string {
  const tail = name.split("::").at(-1) ?? name
  return tail.split(".").at(-1) ?? tail
}
