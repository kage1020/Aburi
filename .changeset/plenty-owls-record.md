---
"@aburi/lang-typescript": minor
---

Record the `export` keyword as evidence on every kind of declaration

`derivedBy` carried `export-keyword` for an exported function, class and variable and carried
nothing for an exported interface, type alias, enum or namespace. `visibility` was right for all
seven — `computeTopLevelVisibility` reads the statement the declaration was written as, so every
exported declaration was already `public` — so what a consumer got was not a missing field but a
spelling-dependent answer: asking a Symbol "was this exported?" through the evidence vocabulary
was answered for the `const` and answered with silence for the `interface` beside it. The four
builders wrote a one-token `derivedBy` naming the kind and stopped there.

They now read the keyword like the others do, and one reader answers for every kind. It has to be
one, because the node each builder holds is different — the `module` for a namespace, the
enclosing `lexical_declaration` for a variable, the declaration itself for the rest — and two
readers is where the kinds start to disagree again. The reader reaches the statement through the
`declare` wrapper, so `export declare interface I {}` answers as `export interface I {}` does.
`export default` still replaces the keyword rather than joining it: one statement cannot be
written with both, and the default export is the token a framework plugin reads to find a page or
a component. `export default interface I {}` therefore carries `export-default` now, where it
used to carry no export evidence at all.

The change is additive — every Symbol that carried the token still carries it, and no Symbol
disappears — but exported interfaces, type aliases, enums and namespaces gain a `derivedBy` entry
they did not have, so IR output and any diff of it against an older document will show it.
`export-keyword` was already declared in the plugin manifest, so nothing downstream has to be
registered. `lang-plugin.md` §9.1 records the rule as LP6b.
