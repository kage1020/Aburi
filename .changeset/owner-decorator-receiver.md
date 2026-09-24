---
"@aburi/types": minor
"@aburi/core": minor
---

Effect plugins see the receiver a decorator was written through

`ClassifyContext.owner.decorators` carried only each decorator's `name` and `boundary`, so an
effect plugin could not tell `@tsed.Post()` from a `@Post()` imported from another library — the
receiver that framework plugins already resolve against the file's imports never reached it. Each
entry now carries `qualifier` when the decorator had one (`tsed` here), and omits the key for a
bare decorator, as `Decorator` does. The field is optional, so existing plugins and code building an
`OwnerSummary` compile unchanged.
