---
name: file-ops
description: Housekeeping on the user's PC — find duplicates, archive, rename, clean Downloads — without ever hard-deleting.
---

# File operations

## Non-negotiables
- **Deletes go to the Recycle Bin** (`/api/fs/trash` or `Microsoft.VisualBasic.FileIO`), never `Remove-Item`
  without `-Confirm`, never `rm -rf`.
- Before moving or renaming more than 3 files, print the plan and the count, and ask.
- Touch only paths under the user's home or the workspace. Never `C:\Windows`, `Program Files`, or a drive root.

## Finding things
Use the **PC index** first (`index` tool, action=search) — it is instant and covers the whole disk. Only walk
the filesystem directly when the index has no hit.

## Housekeeping patterns
```powershell
# duplicates by size+name (report only)
Get-ChildItem $home -Recurse -File -ErrorAction SilentlyContinue |
  Group-Object Length,Name | Where-Object Count -gt 1 | Select-Object -First 20 Name,Count
```
For each proposed action print: what, where, why, and the size reclaimed. Then wait for approval.

## Reporting
Give a table: file, action, bytes freed, new location. State anything skipped and why.
