# A module move the report sees through

A React storefront moves its money helpers from `src/utils/` to `src/lib/`, reorders them and lets the
formatter spread them over more lines. Git shows one file deleted, one file added and an edited import:
every line of the helpers is in the diff.

None of it changes what the code does. Aburi pairs each helper with its old self by fingerprint, so the
report lists them as moved rather than as a removal and an unrelated addition. It reports no API or logic
change anywhere; the only other entries are the cart's call edges, which now point at the helpers' new
home.
