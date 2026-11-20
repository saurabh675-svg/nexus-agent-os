---
name: office-decks
description: Build and edit PowerPoint decks with python-pptx, including MCQ answer keys in speaker notes, then prove the file exists.
---

# Decks (pptx)

## Rules that prevent the failure we already hit
1. **Never claim a deck exists until `os.path.exists(path)` is true.** If the script fails, say so with the traceback.
2. `python-pptx` must import. If `ImportError`, run `python -m pip install --user python-pptx` first, then retry.
3. Write output to an absolute path you control, e.g. `C:\Nexus\data\workspace\<name>.pptx`.

## Build
```python
from pptx import Presentation
from pptx.util import Pt
prs = Presentation()                      # or Presentation(r"template.potx") to inherit branding
for title, bullets in slides:
    s = prs.slides.add_slide(prs.slide_layouts[1])   # 0 title, 1 title+content, 5 title-only
    s.shapes.title.text = title
    body = s.placeholders[1].text_frame
    body.text = bullets[0]
    for b in bullets[1:]:
        body.add_paragraph().text = b
    if answer:                              # MCQ: answer in speaker notes
        s.notes_slide.notes_text_frame.text = f"Answer: {answer}"
prs.save(out); assert __import__("os").path.exists(out)
```

## Editing an existing deck
Open it, keep the theme, only replace text: iterate `slide.shapes`, `if shape.has_text_frame`. Never rebuild from scratch when the user gave a template — branding lives in the layout and the slide master.

## Verify before answering
- slide count: `len(prs.slides)`
- file size > 20 KB
- then open it in the **Viewer** app; it renders real slide images through PowerPoint.
