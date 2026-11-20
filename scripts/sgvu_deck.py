"""Build a lecture deck in the SGVU house style, measured from the real reference deck.

Geometry (inches, 10 x 7.5 slide) was read out of Principles_of_Visual_Perception_..._SGVU.pptx:

  title        0.54, 1.29   8.85 x 0.73   25.5pt bold  #002060
  body bullet  0.56, 2.34+  5.71 x 1.04   19.5pt       #182B45   (right column keeps an image)
  section head 0.56, 2.29+  8.80 x 0.73   21.75pt bold #005B78
  question     0.56, 2.21   5.52 x 1.25   21.0pt bold  #182B45
  option       0.56, 3.65+  5.52 x 0.57   18.75pt      #182B45   (steps of 0.61)
  vote line    0.56, 6.36   8.80 x 0.30   15.75pt bold #005B78
  credit       0.56, 6.69   8.85 x 0.14   8.25pt       #536478
  footer       7.02 band, white 10.5pt: org line, "Menu", page number

Images: public domain / CC0 only, so a published deck carries no licence obligation.
"""
import json
import os
import sys

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

NAVY = RGBColor(0x00, 0x20, 0x60)
TEAL = RGBColor(0x00, 0x5B, 0x78)
SLATE = RGBColor(0x18, 0x2B, 0x45)
GREY = RGBColor(0x53, 0x64, 0x78)
RED = RGBColor(0xC0, 0x00, 0x00)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

ORG = "Centre for Distance and Online Education   GI-9007"


def clear_slides(prs):
    """Keep master, theme and layouts; drop the template's own 35 content slides."""
    id_list = prs.slides._sldIdLst
    for sld in list(id_list):
        r_id = sld.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        try:
            prs.part.drop_rel(r_id)
        except Exception:
            pass
        id_list.remove(sld)


def text_box(slide, l, t, w, h, text, size, color=SLATE, bold=False, align=PP_ALIGN.LEFT, line=1.0):
    box = slide.shapes.add_textbox(Inches(l), Inches(t), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = 0
    tf.margin_right = 0
    tf.margin_top = 0
    tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.TOP
    lines = text if isinstance(text, list) else [text]
    for i, line_text in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = line
        r = p.add_run()
        r.text = line_text
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.color.rgb = color
    return box


def footer(slide, page, org=ORG):
    bar = slide.shapes.add_shape(1, Inches(0), Inches(7.0), Inches(10), Inches(0.5))
    bar.fill.solid()
    bar.fill.fore_color.rgb = NAVY
    bar.line.fill.background()
    bar.shadow.inherit = False
    text_box(slide, 0.6, 7.06, 7.6, 0.28, org, 10.5, WHITE)
    text_box(slide, 8.4, 7.06, 0.6, 0.28, "Menu", 10.5, WHITE, bold=True)
    text_box(slide, 9.2, 7.06, 0.4, 0.28, str(page), 10.5, WHITE, align=PP_ALIGN.RIGHT)


def slide_title(slide, title):
    text_box(slide, 0.54, 1.29, 8.85, 0.73, title, 25.5, NAVY, bold=True)


def bullets(slide, items, top=2.34, width=5.71, step=1.2, height=1.04, size=19.5, color=SLATE, bold=False):
    for i, item in enumerate(items):
        text_box(slide, 0.56, top + i * step, width, height, item, size, color, bold=bold)


def fit_picture(slide, zone, path):
    """Place an image inside (l,t,w,h) without distorting it."""
    l, t, w, h = zone
    try:
        from PIL import Image
        with Image.open(path) as im:
            iw, ih = im.size
    except Exception:
        iw = ih = None
    if iw and ih:
        ar = iw / ih
        if ar >= w / h:
            pw, ph = w, w / ar
        else:
            ph, pw = h, h * ar
        pl = l + (w - pw) / 2
        pt = t + (h - ph) / 2
    else:
        pl, pt, pw, ph = l, t, w, h
    slide.shapes.add_picture(path, Inches(pl), Inches(pt), Inches(pw), Inches(ph))


def credit(slide, line):
    if line:
        text_box(slide, 0.56, 6.69, 8.85, 0.14, line, 8.25, GREY)


def notes_for(slide, narration, credit_line=""):
    text = "READ ALOUD\n" + (narration or "")
    if credit_line:
        text += "\n\n" + credit_line
    slide.notes_slide.notes_text_frame.text = text


def build(template, outline_path, out_path, img_dir=None, pd_only=True):
    with open(outline_path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    img_dir = img_dir or os.path.join(os.path.dirname(os.path.abspath(out_path)), ".deck-images")
    os.makedirs(img_dir, exist_ok=True)

    fetch_image = None
    import_error = None
    try:
        from images import fetch as fetch_image
    except Exception as e:  # loud, never silent
        import_error = str(e)[:200]

    prs = Presentation(template)
    clear_slides(prs)
    blank = next((l for l in prs.slide_layouts if l.name == "Blank"), prs.slide_layouts[-1])

    credits, pictures = [], 0
    cache = {}

    def get_image(query, key):
        """Fetch a public-domain image once per query; return (path, credit)."""
        if not query:
            return None, ""
        if query in cache:
            return cache[query]
        if fetch_image is None:
            return None, f"(image module unavailable: {import_error})"
        got = fetch_image(query, img_dir, pd_only=pd_only)
        if got.get("ok"):
            cache[query] = (got["file"], got["credit"])
        else:
            cache[query] = (None, f"(no public-domain image for '{query}')")
        return cache[query]

    page = 0
    # Fetch every image in parallel first: nine serial Wikimedia round-trips took over ten minutes.
    queries = []
    for s in spec.get("slides", []):
        q = s.get("image_query") or (spec.get("title") if s.get("type") == "title" else None)
        if q and q not in queries:
            queries.append(q)
    if queries:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda q: get_image(q, "prefetch"), queries))

    for s in spec.get("slides", []):
        page += 1
        kind = s.get("type", "concept")
        slide = prs.slides.add_slide(blank)
        narration = s.get("narration", "")
        image_note = ""
        pics_before = pictures

        if kind == "title":
            text_box(slide, 0.54, 1.29, 8.85, 0.73, spec.get("title", ""), 25.5, NAVY, bold=True)
            text_box(slide, 0.56, 2.11, 3.8, 0.36, spec.get("lecture", "Lecture"), 18.75, RED, bold=True)
            text_box(slide, 0.56, 2.62, 3.8, 0.83, spec.get("course", ""), 19.5, SLATE)
            text_box(slide, 0.56, 3.7, 3.8, 0.92, spec.get("org", "Centre for Distance and Online Education"), 18.75, SLATE, bold=True)
            text_box(slide, 0.56, 4.75, 4.01, 1.31, spec.get("coordinator", []), 14.25, SLATE)
            path, cred = get_image(s.get("image_query") or spec.get("title"), "title")
            if path:
                fit_picture(slide, (4.86, 2.44, 4.55, 2.56), path)
                pictures += 1
                credits.append(cred)
            else:
                image_note = cred
            text_box(slide, 4.97, 5.49, 4.33, 0.78, spec.get("program", []), 15.75, SLATE)

        elif kind == "objectives":
            slide_title(slide, s.get("title", "Learning objectives"))
            bullets(slide, s.get("bullets", [])[:3], top=2.34, width=5.71, step=1.2)
            path, cred = get_image(s.get("image_query"), "right")
            if path:
                fit_picture(slide, (6.56, 2.7, 2.81, 2.97), path)
                pictures += 1
                credits.append(cred)
            else:
                image_note = cred

        elif kind == "section":
            slide_title(slide, s.get("title", "Overview"))
            bullets(slide, s.get("parts", []), top=2.29, width=8.8, step=0.94, height=0.73, size=21.75, color=TEAL, bold=True)
            if s.get("note"):
                text_box(slide, 0.56, 4.27, 4.79, 1.41, s["note"], 18.75, SLATE)
            path, cred = get_image(s.get("image_query"), "small")
            if path:
                fit_picture(slide, (6.2, 4.27, 2.78, 1.56), path)
                pictures += 1
                credits.append(cred)
            else:
                image_note = cred

        elif kind == "mcq":
            slide_title(slide, s.get("title", "MCQ"))
            text_box(slide, 0.56, 2.21, 5.52, 1.25, s.get("question", ""), 21.0, SLATE, bold=True)
            for i, opt in enumerate(s.get("options", [])[:4]):
                text_box(slide, 0.56, 3.65 + i * 0.61, 5.52, 0.57, opt, 18.75, SLATE)
            text_box(slide, 0.56, 6.36, 8.8, 0.3, "Vote A–D. Click a choice to reveal the answer.", 15.75, TEAL, bold=True)
            path, cred = get_image(s.get("image_query"), "mcq")
            if path:
                fit_picture(slide, (6.51, 3.1, 2.91, 2.22), path)
                pictures += 1
                credits.append(cred)
            else:
                image_note = cred

        elif kind == "answer":
            slide_title(slide, s.get("title", "Answer"))
            text_box(slide, 0.56, 2.21, 5.62, 1.35, s.get("correct", ""), 21.0, TEAL, bold=True)
            text_box(slide, 0.56, 3.8, 5.62, 1.41, s.get("explanation", ""), 18.75, SLATE)
            text_box(slide, 0.56, 6.29, 2.81, 0.34, "Retry question", 17.25, TEAL, bold=True)
            text_box(slide, 3.75, 6.29, 2.29, 0.34, "Continue", 17.25, TEAL, bold=True)
            path, cred = get_image(s.get("image_query"), "answer")
            if path:
                fit_picture(slide, (6.51, 3.06, 2.91, 2.22), path)
                pictures += 1
                credits.append(cred)
            else:
                image_note = cred

        elif kind == "wide":
            slide_title(slide, s.get("title", ""))
            path, cred = get_image(s.get("image_query"), "wide")
            if path:
                fit_picture(slide, (1.9, 2.05, 6.2, 3.2), path)
                pictures += 1
                credits.append(cred)
                bullets(slide, s.get("bullets", [])[:3], top=5.45, width=8.79, step=0.47, height=0.45, size=18.0)
            else:
                image_note = cred
                bullets(slide, s.get("bullets", [])[:4], top=2.3, width=8.79, step=0.95, height=0.9, size=19.5)

        else:  # concept: bullets, optional right-column image
            slide_title(slide, s.get("title", ""))
            items = s.get("bullets", [])[:4]
            zone = s.get("image_zone", "right")
            path, cred = get_image(s.get("image_query"), zone)
            if path and zone != "none":
                bullets(slide, items, top=2.34, width=5.71, step=1.05, height=0.95)
                fit_picture(slide, (6.51, 2.6, 2.91, 2.9), path)
                pictures += 1
                credits.append(cred)
            else:
                image_note = cred
                bullets(slide, items, top=2.3, width=8.79, step=0.95, height=0.9)

        footer(slide, page)
        slide_credit = credits[-1] if pictures > pics_before else image_note
        credit(slide, slide_credit)
        notes_for(slide, narration, slide_credit)

    prs.save(out_path)
    return {
        "ok": True,
        "path": out_path,
        "slides": len(prs.slides),
        "pictures": pictures,
        "bytes": os.path.getsize(out_path),
        "credits": credits,
        "unavailable": [c for c in credits if str(c).startswith("(")],
    }


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "build"]
    if len(args) < 3:
        print(json.dumps({"error": "usage: sgvu_deck.py build <template.pptx> <outline.json> <out.pptx>"}))
        sys.exit(1)
    result = build(args[0], args[1], args[2])
    print(json.dumps(result))
