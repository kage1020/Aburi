---
"@aburi/plugin-registry": patch
---

A manifest that declares one effect id or extKind twice is refused, and an unknown `type` is always `manifest-invalid`

The registry compared a manifest only with the plugins already registered, so an id declared twice
in one manifest kept whichever came last, and a hand-built manifest with `type: "toString"` found
`Object.prototype.toString` as its rules and failed with an uncoded `TypeError`. Both now raise the
coded errors the other cases already do (`duplicate-id`, `manifest-invalid`), and the plugin schema
marks `provides.extKinds` `uniqueItems` like the arrays beside it.
