---
"@aburi/diff": patch
---

An unchanged rule, call or decorator pairs with its counterpart however far its body moved

The pass that pairs elements whose content already agrees no longer applies the ±`lineFuzz`
window, so a function that moved 14 lines down its file stops listing every call as both added
and removed. Order is kept only among elements of one key: a call that moved below a call to a
different target is still the same call. `lineFuzz` now decides one thing — how far an edited
element may sit from the one it replaced and still read as `modified`.
