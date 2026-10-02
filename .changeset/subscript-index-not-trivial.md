---
"@aburi/lang-typescript": patch
---

A returned bracket access whose index is computed, `return cache[computeKey(key)]` or `return LABELS[await prisma.user.count()]`, is no longer read as a trivial return. Only the object was checked, so the whole return was skipped and every call in the index was lost from `calls[]` and `effects[]`: reading the index from the database was reported as a syntax-only change, and the same call was recorded as soon as it was hoisted into a local. Such a return is now a `return` rule and its calls are recorded. `items[0]` and `map[key]` stay trivial. Symbols that return such an access get a new `logic` value once.
