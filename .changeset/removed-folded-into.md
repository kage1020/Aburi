---
"@aburi/types": minor
"@aburi/diff": minor
---

A removal whose body a head Symbol still holds says so. Folding two identical helpers into one pairs one of them with the survivor and leaves the other `removed`, and nothing joined the two for a reader. A `removed` entry now carries `foldedInto`: the id of the head Symbol, paired or not, that has its kind, its logic fingerprint and its syntax fingerprint, when its logic names something, choosing the closest name when several do, and `null` otherwise. The syntax has to agree because unrelated helpers share a logic fingerprint often (one `if (x === null) throw new Error(…)` guard is the whole logic of many), and a fold takes the removal out of `--fail-on removed`. `summary.removedFolded` counts the folded entries, which `summary.removed` still counts too. `aburi diff` writes both on every diff, `null` and `0` included, so a reader can tell "not folded" from a diff written before the field existed. Both fields are additive and optional in `aburi.diff.v1.json`.
