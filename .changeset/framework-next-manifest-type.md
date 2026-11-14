---
"@aburi/framework-next": patch
---

Type `frameworkNextManifest` as `FrameworkManifest`, as every other framework plugin types its manifest, instead of the literal type of the object it holds. Code that read a literal such as `frameworkNextManifest.provides.extKinds[0].id` as `"framework:next:page"` now reads `string`.
