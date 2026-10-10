import type { Rule } from "@aburi/types"

/** How many characters of a rule string reach the IR before it is cut. */
export const RULE_TEXT_LIMIT = 120

/** What marks a rule string that was cut: the schema's `maxLength: 123` is the limit plus this. */
const ELLIPSIS = "..."

export function normalizeRuleText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  const chars = Array.from(collapsed)
  if (chars.length <= RULE_TEXT_LIMIT) return collapsed
  return chars.slice(0, RULE_TEXT_LIMIT).join("") + ELLIPSIS
}

export function normalizeRuleStrings(rule: Rule): Rule {
  const condition = rule.condition === null ? null : normalizeRuleText(rule.condition)
  const what = rule.what === null ? null : normalizeRuleText(rule.what)
  const expr = rule.expr === null ? null : normalizeRuleText(rule.expr)
  if (condition === rule.condition && what === rule.what && expr === rule.expr) return rule
  return { ...rule, condition, what, expr }
}
