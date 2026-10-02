---
"@aburi/lang-typescript": patch
---

A class's head — `abstract`, its type parameters, `extends` and `implements` — now reaches its `syntax` fingerprint. Only the class body was serialized, and a class has no signature for the api axis to read, so re-parenting a class, dropping `abstract` or adding a required type parameter left every fingerprint identical and `aburi diff` reported no change. The head is appended after the body only when present, so a class with none keeps its fingerprint; classes that have one get a new `syntax` value once.
