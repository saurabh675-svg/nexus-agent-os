---
name: pdf-work
description: Read, search, split and merge PDFs; never pretend a scanned PDF has text when it does not.
---

# PDFs

## Read
```python
from pypdf import PdfReader      # if missing: python -m pip install --user pypdf
r = PdfReader(path); print(len(r.pages)); print((r.pages[0].extract_text() or "")[:800])
```
If `extract_text()` returns empty for most pages, the PDF is a scan. Say so plainly and offer OCR
(`ocrmypdf` if installed) instead of inventing content.

## Split / merge
```python
w = PdfWriter()
for i in [2,3,4]: w.add_page(r.pages[i-1])       # 1-based page numbers in, 0-based indexing
with open(out, "wb") as f: w.write(f)
```

## Rules
- Quote page numbers when summarising, e.g. "p.4 says …".
- Never claim a page count you did not read from `len(reader.pages)`.
- Output files go to an absolute path; verify with `os.path.getsize`.
