---
"@aburi/lang-typescript": patch
---

Overload signatures written beside their implementation (`function parse(input: string): Config;` before `function parse(input: any): any { … }`, and method overloads in a class) now fold into the implementation's Symbol as declarations with no body, so they reach its `syntax` fingerprint. They were dropped, so adding, removing or retyping an overload left every fingerprint identical and `aburi diff` reported no change. The implementation still leads and supplies the signature and body; such Symbols now carry `declaration-merged` and get a new `syntax` value once. Overloads with no implementation beside them still produce no Symbol.
