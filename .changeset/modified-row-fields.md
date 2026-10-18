---
"@aburi/markdown-projection": patch
---

A modified rule, effect, call, decorator or input in `diff.md` now shows what changed about it. A loop row names its kind, and under `rules modified` the kind it had, ``loop (`for` → `while`) (L3)``, where it read `loop (L3)` whatever the kind. An effect row carries its plugin and confidence badge in every bucket, as on the component page, and a modified one keeps the base value of each field that differs, ``db.write: `prisma.user.create` (L5) [effects-prisma] ⚠ medium (was high)``, where it read the same as the effect nobody touched. A rewritten guard, throw or return gives its old payload before the new one; a modified call names what it resolved to before and after, ``resolved: `ts:src/hooks.ts#useInvoices` → none``; a modified decorator prints its written form on both sides, arguments included, where it printed only its name; and a modified input gives its old spelling. Where the base Symbol holds several elements under the element's key that disagree on a field, that field shows the new value alone.

Nothing in the IR or `diff.json` changes. The base values are read from each entry's `before`, so a `diff.json` written by an earlier version renders the new rows too.
