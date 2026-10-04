---
"@aburi/markdown-projection": patch
---

The size cap now weighs each section's forms by the whole document, note included. A section whose names-only form costs more in the note than it saves is kept whole, below a names-only section too, where it used to be named only in a larger document or omitted although it fit whole. A section omitted early is put back once there is room for it.
