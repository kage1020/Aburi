---
"@aburi/effects-drizzle": patch
---

A zero-argument `batch()` or `transaction()` in a file that imports `drizzle-orm` is no longer a reason to withdraw the file. Drizzle's `batch` and `transaction` both take an argument, so a Firestore `firestore.batch()`, an unmanaged Sequelize or Knex `transaction()` or a class's own `this.transaction()` is another library's call: it now stays in `calls[]` with no effect, where it used to throw, cost the file every Symbol it declared and exit `aburi scan` with 3 (#386).
