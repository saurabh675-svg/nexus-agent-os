"""Extract text/metadata from docx, pptx, xlsx, pdf and images using only the Python stdlib where possible.

Usage: python extract.py <file>
Prints one JSON line: {"kind": "...", "text": "...", "chars": n, "error": "..."}
"""
import json
import os
import re
import sys
import zipfile


def clean(s):
    return re.sub(r"\s+", " ", s).strip()


def docx_text(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
    xml = xml.replace("</w:p>", "\n")
    text = re.sub(r"<[^>]+>", "", xml)
    return clean(text)[:20000], {"paragraphs": text.count("\n") + 1}


def pptx_text(path):
    with zipfile.ZipFile(path) as z:
        slides = sorted(n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n))
        notes = sorted(n for n in z.namelist() if re.match(r"ppt/notesSlides/notesSlide\d+\.xml$", n))
        out = []
        for i, s in enumerate(slides, 1):
            xml = z.read(s).decode("utf-8", "ignore")
            xml = xml.replace("</a:p>", "\n").replace("</p:sp>", "\n---\n")
            text = re.sub(r"<[^>]+>", "", xml)
            out.append(f"[slide {i}]\n{clean_multiline(text)}")
        for i, n in enumerate(notes, 1):
            xml = z.read(n).decode("utf-8", "ignore")
            text = clean(re.sub(r"<[^>]+>", "", xml))
            if text:
                out.append(f"[notes {i}] {text}")
    return ("\n\n".join(out))[:20000], {"slides": len(slides), "notes": len(notes)}


def clean_multiline(s):
    lines = [clean(l) for l in s.split("\n")]
    return "\n".join(l for l in lines if l)


def xlsx_text(path):
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            xml = z.read("xl/sharedStrings.xml").decode("utf-8", "ignore")
            for m in re.finditer(r"<si>(.*?)</si>", xml, re.S):
                shared.append(clean(re.sub(r"<[^>]+>", "", m.group(1))))
        sheets = [n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)]
        rows_out = []
        for s in sorted(sheets)[:5]:
            xml = z.read(s).decode("utf-8", "ignore")
            for row in list(re.finditer(r"<row[^>]*>(.*?)</row>", xml, re.S))[:40]:
                cells = re.findall(r"<c[^>]*?(?: t=\"s\")?[^>]*>(?:<v>([^<]*)</v>)?", row.group(1))
                vals = []
                for c in re.finditer(r"<c([^>]*)>(.*?)</c>", row.group(1), re.S):
                    attrs, body = c.group(1), c.group(2)
                    v = re.search(r"<v>([^<]*)</v>", body)
                    val = v.group(1) if v else clean(re.sub(r"<[^>]+>", "", body))
                    if 't="s"' in attrs and val.isdigit() and int(val) < len(shared):
                        val = shared[int(val)]
                    vals.append(val)
                rows_out.append(" | ".join(vals))
    return ("\n".join(rows_out))[:20000], {"sheets": len(sheets)}


def pdf_text(path):
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception:
        try:
            from PyPDF2 import PdfReader  # type: ignore
        except Exception:
            return "", {"error": "pdf reader not installed - run: pip install pypdf"}
    reader = PdfReader(path)
    pages = []
    for i, p in enumerate(reader.pages[:40], 1):
        try:
            pages.append(f"[page {i}]\n{p.extract_text() or ''}")
        except Exception:
            continue
    return ("\n\n".join(pages))[:20000], {"pages": len(reader.pages)}


def image_meta(path):
    try:
        from PIL import Image  # type: ignore
        with Image.open(path) as im:
            return "", {"width": im.width, "height": im.height, "mode": im.mode}
    except Exception as e:
        return "", {"error": f"image metadata unavailable: {e}"}


def main():
    path = sys.argv[1]
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".docx":
            text, meta = docx_text(path)
        elif ext == ".pptx":
            text, meta = pptx_text(path)
        elif ext == ".xlsx":
            text, meta = xlsx_text(path)
        elif ext == ".pdf":
            text, meta = pdf_text(path)
        elif ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"):
            text, meta = image_meta(path)
        else:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read(20000)
            meta = {}
        payload = {"kind": ext.lstrip("."), "text": text, "chars": len(text), **meta}
        if not text and "error" not in payload:
            payload["error"] = "no extractable text"
    except Exception as e:
        payload = {"kind": ext.lstrip("."), "text": "", "chars": 0, "error": str(e)[:300]}
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
