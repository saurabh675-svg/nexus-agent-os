---
name: spreadsheets
description: Work with xlsx and csv safely — inspect before editing, keep formulas, never silently drop rows.
---

# Spreadsheets (xlsx / csv)

## Always inspect first
```python
import pandas as pd
df = pd.read_csv(path) if path.endswith(".csv") else pd.read_excel(path, sheet_name=None)
print(df.shape, list(df.columns)[:20], df.head(3).to_dict())
```
State the row count and column names before doing anything. If the file has more than one sheet, say which
sheet you are touching.

## Editing rules
- **Never overwrite the input.** Write `<name>_edited.xlsx` next to it.
- Preserve formulas when the user cares about a live sheet: use `openpyxl` with `data_only=False`, and only
  write into cells you were asked to change.
- Dropping rows is destructive: report `before → after` counts and why.
- Dates and money: keep the source format; do not silently retype.

## Deliver
For a new workbook: `pd.ExcelWriter(out, engine="openpyxl")`, one sheet per table, freeze the header row,
set column widths. Then verify size > 4 KB and open it in the Viewer.
