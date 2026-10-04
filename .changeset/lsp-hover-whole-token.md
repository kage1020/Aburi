---
"@aburi/core": patch
---

LSP enrichment now hovers the call's own method for a `this.<method>` / `super.<method>` call. It searched the line for `this.save` as a bare substring, so an earlier token it prefixed drew the hover: `this.saveAll(); return this.save()` resolved `this.save` to the base class's `save` through `saveAll`'s owner, `this.handlers.forEach(() => this.handle())` reached `Base.handle` instead of the override, and `mythis.foo(); this.foo()` linked `this.foo` to an unrelated class, all at `high` confidence. The search now matches whole tokens and skips strings and comments on the line, while a call inside a template literal's `${…}` is still found.

Only calls that resolved to the wrong member change. With an effect plugin loaded, the caller of such a call inherits different effects, which moves its `logic` fingerprint; what it inherited before came from a method the call never reaches.
