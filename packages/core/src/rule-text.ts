import type { Rule } from "@aburi/types"

/** How many characters of a rule string reach the IR before it is cut (ir-schema.md §8.2). */
export const RULE_TEXT_LIMIT = 120

/** What marks a rule string that was cut: the schema's `maxLength: 123` is the limit plus this. */
const ELLIPSIS = "..."

/**
 * A rule's `condition`, `what` or `expr` in the form ir-schema.md §8.2 writes it: every run of
 * whitespace (newlines included) collapsed to one space, trimmed, and cut to the first 120
 * characters plus `...` when it is longer than that.
 *
 * Characters are code points, which is what the schema's `maxLength` counts, so a cut never
 * splits a surrogate pair. The cut is idempotent — a string it already produced keeps its first
 * 120 characters and its `...` — which lets the scan apply it at the plugin boundary to rules a
 * language plugin has already written in this form.
 *
 * Removing comments is not part of it: telling a comment from the text around it takes the
 * language's grammar, so a language plugin removes them before it gets here.
 */
export function normalizeRuleText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  const chars = Array.from(collapsed)
  if (chars.length <= RULE_TEXT_LIMIT) return collapsed
  return chars.slice(0, RULE_TEXT_LIMIT).join("") + ELLIPSIS
}

/**
 * The same form applied to the three strings of one rule. The rule comes back unchanged when
 * nothing differs, so an ordinary scan allocates nothing here.
 */
export function normalizeRuleStrings(rule: Rule): Rule {
  const condition = rule.condition === null ? null : normalizeRuleText(rule.condition)
  const what = rule.what === null ? null : normalizeRuleText(rule.what)
  const expr = rule.expr === null ? null : normalizeRuleText(rule.expr)
  if (condition === rule.condition && what === rule.what && expr === rule.expr) return rule
  return { ...rule, condition, what, expr }
}
