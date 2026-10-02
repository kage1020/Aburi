---
"@aburi/effects-drizzle": patch
---

A zero-argument `batch()` or `transaction()` in a file that imports `drizzle-orm` is no longer a reason to withdraw the file. Drizzle's `batch` and `transaction` both take an argument, so no Drizzle signature reaches a Firestore `firestore.batch()`, an unmanaged Sequelize or Knex `transaction()` or a class's own `this.transaction()`: such a call now stays in `calls[]` with no effect, whatever its receiver, where it used to throw, cost the file every Symbol it declared and exit `aburi scan` with 3. A one-argument `transaction(cb)` on a receiver outside the client vocabulary is still recorded, at `medium`.
