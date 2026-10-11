const OWNER_CLASS_PATTERN = /\((?:method|property|getter|setter)\)\s+([A-Za-z_$][A-Za-z0-9_$]*)\./
const CLASS_METHOD_PATTERN = /class\s+([A-Za-z_$][A-Za-z0-9_$]*)/

export function extractOwnerClassName(hoverText: string): string | null {
  return (
    OWNER_CLASS_PATTERN.exec(hoverText)?.[1] ?? CLASS_METHOD_PATTERN.exec(hoverText)?.[1] ?? null
  )
}

const THROWS_TAG_PATTERN =
  /@(?:throws?|exception)(?![\w$])[ \t]*(?:\{([^}\n]+)\})?((?:(?!\n[ \t]*@|[ \t]@[a-zA-Z])[\s\S])*)/g
const THROWS_LINK_PATTERN =
  /^@link(?:code|plain)?\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:[\s|]|$)/
const TYPE_NAME_PATTERN = /^[A-Z][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

export function extractInferredThrowsFromHover(hoverText: string): string[] {
  const out = new Set<string>()
  for (const [, braced, description = ""] of hoverText.matchAll(THROWS_TAG_PATTERN)) {
    if (braced !== undefined) {
      const inBraces = braced.trim()
      const typed = inBraces.startsWith("@") ? THROWS_LINK_PATTERN.exec(inBraces)?.[1] : inBraces
      if (typed !== undefined && typed.length > 0) out.add(typed)
      continue
    }
    const text = description.replace(/\s+/g, " ").trim()
    if (TYPE_NAME_PATTERN.test(text)) out.add(text)
  }
  return [...out]
}
