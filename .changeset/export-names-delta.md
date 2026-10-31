---
"@aburi/types": minor
"@aburi/diff": minor
"@aburi/markdown-projection": minor
---

A changed Symbol's delta says which export names it gained and lost. `SymbolDelta` gains `exportedAs`, an `ArrayDelta` of the names the module exports the Symbol under compared as a set, the Symbol's own name included: `export { handler as GET }` becoming `export { handler as GET, handler as DELETE }` gives `added: ["DELETE"]`, and `export default function Page` becoming `export function Page` gives `added: ["Page"], removed: ["default"]`. `aburi diff` writes it for every changed and moved+changed entry, empty included, so a reader can tell a diff with nothing to report from one written before the field existed. The Markdown report renders it after the decorator rows as `- export name added: …` and `- export name removed: …`, and those rows explain the API flag, so the "no field-level detail was recorded" note no longer follows an API change that only the export names made.
