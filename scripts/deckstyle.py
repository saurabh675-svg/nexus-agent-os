"""Deck intelligence for the user's own lecture style.

analyze <pptx> [--out profile.json]   -> extract the style facts we can honestly observe
build <profile.json> <outline.json> <out.pptx>  -> produce a deck that follows that profile

What it mimics: slide size, dominant fonts and sizes, title/body conventions, notes usage, bullet
density, colour accents actually used in the reference decks.
What it cannot mimic without the .potx: the slide master, theme, logo placement, per-layout artwork.
Usage: python deckstyle.py analyze ...
"""
import json
import glob
import os
import re
import sys
from collections import Counter

# This python runs with safe-path off, so the script's own folder is not importable by default.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pptx import Presentation
from pptx.util import Pt


def iter_runs(slide):
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        for para in shape.text_frame.paragraphs:
            for run in para.runs:
                yield shape, para, run


def theme_fonts(path):
    """Read major/minor latin typefaces straight out of the theme XML — the actual house style."""
    import zipfile
    out = {}
    try:
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if re.match(r"ppt/theme/theme\d+\.xml$", n)]
            if not names:
                return out
            xml = z.read(names[0]).decode("utf-8", "ignore")
            major = re.search(r"<a:majorFont>.*?<a:latin typeface=\"([^\"]*)\"", xml, re.S)
            minor = re.search(r"<a:minorFont>.*?<a:latin typeface=\"([^\"]*)\"", xml, re.S)
            if major:
                out["major"] = major.group(1)
            if minor:
                out["minor"] = minor.group(1)
            # accent colours 1-6 from the theme palette
            accents = re.findall(r"<a:accent(\d)>.*?val=\"([0-9A-Fa-f]{6})\"", xml, re.S)
            if accents:
                out["accents"] = {f"accent{a}": v.upper() for a, v in accents[:6]}
            bg = re.search(r"<a:srgbClr val=\"([0-9A-Fa-f]{6})\"/>", xml)
            if bg:
                out["first_color"] = bg.group(1).upper()
    except Exception as e:
        out["error"] = str(e)[:120]
    return out


def analyze(path):
    prs = Presentation(path)
    fonts, sizes, title_sizes, body_sizes = Counter(), Counter(), Counter(), Counter()
    colors = Counter()
    bullets_per_slide = []
    notes = 0
    images = 0
    layouts_used = Counter()

    for slide in prs.slides:
        layouts_used[slide.slide_layout.name] += 1
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
            notes += 1
        for shape in slide.shapes:
            if shape.shape_type == 13:  # PICTURE
                images += 1
        n = 0
        for shape, para, run in iter_runs(slide):
            txt = (run.text or "").strip()
            if not txt:
                continue
            if run.font.name:
                fonts[run.font.name] += 1
            if run.font.size:
                pt = int(run.font.size.pt)
                sizes[pt] += 1
                if shape == slide.shapes.title:
                    title_sizes[pt] += 1
                else:
                    body_sizes[pt] += 1
            try:
                if run.font.color and run.font.color.rgb:
                    colors[str(run.font.color.rgb)] += 1
            except Exception:
                pass
            if para.level == 0 and shape != slide.shapes.title:
                n += 1
        if n:
            bullets_per_slide.append(n)

    def top(counter, k=3):
        return counter.most_common(k)

    profile = {
        "source": os.path.basename(path),
        "slides": len(prs.slides),
        "slide_size_in": [round(prs.slide_width / 914400, 2), round(prs.slide_height / 914400, 2)],
        "theme": theme_fonts(path),
        "layouts_used": layouts_used.most_common(4),
        "fonts": top(fonts, 4),
        "font_sizes": top(sizes, 6),
        "title_sizes": top(title_sizes, 2),
        "body_sizes": top(body_sizes, 3),
        "accent_colors": top(colors, 4),
        "notes_on_slides": notes,
        "pictures": images,
        "bullets_per_slide": {
            "median": sorted(bullets_per_slide)[len(bullets_per_slide) // 2] if bullets_per_slide else 4,
            "max": max(bullets_per_slide) if bullets_per_slide else 6,
        },
    }
    return profile


def clear_slides(prs):
    """Keep the template's master, theme, layouts and artwork; drop its content slides."""
    sldIdLst = prs.slides._sldIdLst
    for sld in list(sldIdLst):
        rId = sld.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        try:
            prs.part.drop_rel(rId)
        except Exception:
            pass
        sldIdLst.remove(sld)


def pick_layout(prs, want_body=True):
    """Templates rarely use the default layout order. Choose by capability, not by index.
    Note: a *layout* has no .title property (that's only on slides) — inspect placeholders instead."""
    TITLE_TYPES = {1, 3, 13}
    BODY_TYPES = {2, 7, 4}
    best = None
    for i, layout in enumerate(prs.slide_layouts):
        try:
            types = [ph.placeholder_format.type for ph in layout.placeholders]
        except Exception:
            continue
        has_title = any(t in TITLE_TYPES for t in types)
        bodies = [t for t in types if t in BODY_TYPES]
        score = (1 if has_title else 0) + (len(bodies) if want_body else 0)
        if best is None or score > best[0]:
            best = (score, i, layout)
    return best[2] if best else prs.slide_layouts[0]


def body_frame(slide, left=None, top=None, width=None, height=None):
    """A text frame for bullets: a real body placeholder if present, otherwise a textbox."""
    for ph in slide.placeholders:
        if ph.placeholder_format.idx == 0:
            continue
        if ph.placeholder_format.type in (2, 7, 3, 1):
            try:
                return ph.text_frame
            except Exception:
                pass
    box = slide.shapes.add_textbox(
        left if left is not None else Inches(0.6),
        top if top is not None else Inches(1.7),
        width if width is not None else Inches(8.8),
        height if height is not None else Inches(4.2),
    )
    return box.text_frame


def set_title(slide, text, font, pt):
    title = slide.shapes.title
    if title is None:
        tb = slide.shapes.add_textbox(Inches(0.6), Inches(0.6), Inches(8.8), Inches(0.9))
        tf = tb.text_frame
        tf.text = text
        target = tf.paragraphs[0]
    else:
        title.text = text
        target = title.text_frame.paragraphs[0]
    for run in target.runs:
        run.font.name = font
        run.font.size = Pt(pt)
    return target


def build(profile_path, outline_path, out_path, template=None):
    with open(profile_path, "r", encoding="utf-8") as f:
        prof = json.load(f)
    with open(outline_path, "r", encoding="utf-8") as f:
        outline = json.load(f)

    prs = Presentation()
    using_template = bool(template and os.path.exists(template))
    if using_template:
        prs = Presentation(template)
        clear_slides(prs)
    prs.slide_width = int(prof["slide_size_in"][0] * 914400)
    prs.slide_height = int(prof["slide_size_in"][1] * 914400)
    # Create the target folder first: "No such file or directory" on save is the single most common
    # way a deck build dies after doing all the work.
    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)
    img_dir = os.path.join(out_dir, ".deck-images")
    os.makedirs(img_dir, exist_ok=True)

    try:
        from images import fetch as fetch_image
        image_import_error = None
    except Exception as e:
        fetch_image = None
        image_import_error = str(e)[:200]

    title_font = None
    if prof.get("theme", {}).get("major"):
        title_font = prof["theme"]["major"]
    elif prof.get("fonts"):
        title_font = prof["fonts"][0][0]
    title_font = title_font or "Calibri"
    body_font = prof.get("theme", {}).get("minor") or title_font
    title_pt = prof["title_sizes"][0][0] if prof.get("title_sizes") else 32
    body_pt = 20 if prof["body_sizes"] and prof["body_sizes"][0][0] < 12 else (prof["body_sizes"][0][0] if prof.get("body_sizes") else 18)

    content_layout = pick_layout(prs, want_body=True)
    title_layout = pick_layout(prs, want_body=False)

    def add_title_slide(title, subtitle):
        slide = prs.slides.add_slide(title_layout)
        set_title(slide, title, title_font, title_pt)
        for ph in slide.placeholders:
            if ph.placeholder_format.idx == 0:
                continue
            try:
                ph.text = subtitle or ""
                for p in ph.text_frame.paragraphs:
                    for r in p.runs:
                        r.font.name = body_font
                        r.font.size = Pt(body_pt)
                break
            except Exception:
                continue
        return slide

    def add_content_slide(title, bullets, notes=None):
        slide = prs.slides.add_slide(content_layout)
        set_title(slide, title, title_font, title_pt)
        body = body_frame(slide)
        body.text = ""
        first = True
        for b in bullets:
            p = body.paragraphs[0] if first else body.add_paragraph()
            first = False
            p.text = b
            p.level = 0
            for run in p.runs:
                run.font.name = body_font
                run.font.size = Pt(body_pt)
        if notes:
            slide.notes_slide.notes_text_frame.text = notes
        return slide

    add_title_slide(outline.get("title", "Lecture"), outline.get("subtitle", ""))
    credits = []

    for i, s in enumerate(outline.get("slides", []), start=2):
        notes = s.get("notes") or ""
        # Web image for this slide: CC-licensed only, downloaded, and credited in the speaker notes.
        if s.get("image_query"):
            if fetch_image is None:
                # Loud, not silent: a missing module must show up in the deck's notes.
                notes = (notes + "\n\n(image module unavailable: %s)" % image_import_error).strip()
            else:
                got = fetch_image(s["image_query"], img_dir)
                if got.get("ok"):
                    s = dict(s)
                    s["image"] = got["file"]
                    notes = (notes + "\n\n" + got["credit"]).strip()
                    credits.append(got["credit"])
                else:
                    notes = (notes + "\n\n(image search failed: %s)" % got.get("error", "no result")).strip()
        slide = add_content_slide(s.get("title", f"Slide {i}"), s.get("bullets", []), notes or None)
        img = s.get("image")
        if img:
            candidate = img if os.path.isabs(img) else os.path.join(img_dir, img)
            if os.path.exists(candidate):
                # full-width picture under the text, keeping the body readable
                try:
                    slide.shapes.add_picture(candidate, 0, prs.slide_height - int(2.6 * 914400), width=prs.slide_width)
                except Exception as e:
                    # A format python-pptx refuses must not kill the whole deck.
                    notes = (notes + "\n\n(image could not be embedded: %s)" % str(e)[:120]).strip()
                    credits.append("image skipped: %s" % str(e)[:80])

    prs.save(out_path)
    exists = os.path.exists(out_path)
    size = os.path.getsize(out_path) if exists else 0
    print(json.dumps({
        "ok": exists and size > 20000,
        "path": out_path,
        "slides": len(prs.slides),
        "bytes": size,
        "fonts": title_font,
        "body_font": body_font,
        "template": using_template,
        "images": len(credits),
        "credits": credits[:6],
        "title_pt": title_pt,
        "body_pt": body_pt,
    }))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: deckstyle.py analyze|build ..."}))
        return
    cmd = sys.argv[1]
    if cmd == "analyze":
        path = sys.argv[2]
        prof = analyze(path)
        if "--out" in sys.argv:
            out = sys.argv[sys.argv.index("--out") + 1]
        else:
            out = os.path.splitext(path)[0] + ".profile.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(prof, f, indent=2)
        prof["profile_path"] = out
        print(json.dumps(prof))
    elif cmd == "build":
        profile_path, outline_path, out_path = sys.argv[2], sys.argv[3], sys.argv[4]
        template = None
        if "--template" in sys.argv:
            template = sys.argv[sys.argv.index("--template") + 1]
        build(profile_path, outline_path, out_path, template=template)
    else:
        print(json.dumps({"error": f"unknown command {cmd}"}))


if __name__ == "__main__":
    main()
