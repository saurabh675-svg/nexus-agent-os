---
name: office-docs
description: Produce Word documents and reports with python-docx — headings, tables, page breaks — and hand back a real file path.
---

# Documents (docx)

## Before writing
Ask yourself: does this need a file at all, or is the chat answer enough? Only build a document when the
user asked for a deliverable, a report, a letter, or something to send.

## Build
```python
from docx import Document
from docx.shared import Pt, Cm
doc = Document()
doc.add_heading("Title", 0)
doc.add_paragraph("Body text.")
t = doc.add_table(rows=1, cols=3); t.style = "Light Grid Accent 1"
hdr = t.rows[0].cells
for i, name in enumerate(["Item", "Owner", "Due"]): hdr[i].text = name
for row in rows:
    cells = t.add_row().cells
    for i, v in enumerate(row): cells[i].text = str(v)
doc.save(out)
```

## Quality bar
- One idea per paragraph; no walls of text.
- Every table has a header row and consistent units.
- Numbers in a document must come from a tool call or the user, never invented.
- If the user gave a template, open it with `Document(template)` and append — do not restyle.

## Verify
`os.path.getsize(out) > 5000`, then open it in the Viewer and read the extracted text back to the user.
