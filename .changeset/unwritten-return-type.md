---
"@aburi/markdown-projection": patch
---

A signature with no outputs prints nothing after its inputs, `(x: number)`, where it printed `(x: number) → void`: an empty `outputs` means no return type was written or inferred, not `void`.
