# A route handler loses its guard

A Next.js App Router endpoint that creates orders. The change reads like a tidy-up of `POST`, but it
deletes the admin check in front of the write and adds a second write to an audit log, reached through a
new helper in another file.

The report puts both on `POST`: the guard under removed rules, and the audit write under added effects,
propagated from `recordAudit` through the call graph. The session lookup the guard depended on disappears
from `POST`'s effects for the same reason.
