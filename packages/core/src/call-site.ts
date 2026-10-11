export const CALL_SITE_KEY_SEPARATOR = "\t"

export function dependencyKey(from: string, to: string, via: string): string {
  return [from, to, via].join(CALL_SITE_KEY_SEPARATOR)
}

export function callEdgeKey(from: string, to: string): string {
  return [from, to].join(CALL_SITE_KEY_SEPARATOR)
}

export function makeCallSiteKey(file: string, line: number, target: string): string {
  return [file, line, target].join(CALL_SITE_KEY_SEPARATOR)
}

export function receiverHead(target: string): string | undefined {
  return target.split(".").find((segment) => segment.length > 0)
}
