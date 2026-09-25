---
"@aburi/markdown-projection": patch
---

A Symbol block's `**Effects**:`, `**Calls**:` and fingerprint lines no longer render inside the bullet above them

The block wrote each section label straight after the previous list, so CommonMark read it as a
continuation of the last bullet: `**Effects**:` showed up attached to the last rule. After a
fenced rule the same label did end the list, so where it landed depended on the length of a
condition. A blank line now follows each list section that something comes after, as §5.2 of the
design doc already showed. Every `components/<id>.md` changes by those blank lines.
