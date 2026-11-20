"""Image sourcing for decks — relevant, licence-clean, credited.

fetch <query> <outdir> [--n 1]  -> JSON {ok, file, credit, candidates_checked}

Rules that matter more than the code:
  * Only licences usable in a published course: PD / CC0 / CC-BY / CC-BY-SA. Never NC (non-commercial)
    and never ND (no-derivatives — we crop and annotate slides, which ND forbids).
  * Relevance: at least one meaningful query term must appear in the title or page name. A map of
    1836 Paris is not a choropleth example, no matter how well it matches "map".
  * Prefer landscape: a portrait image in a 16:9 slide is useless.
  * Download the file; never hotlink. Write creator + licence into the notes.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

UA = {"User-Agent": "NexusDeckBuilder/1.1 (teaching material; local user)"}

BAD_LICENSE = re.compile(r"\b(nc|nd|non-?commercial|no-?deriv)", re.I)
GOOD_LICENSE = re.compile(r"(public domain|cc0|cc[- ]?by(\b|-sa)|pd\b|pdm)", re.I)
# A published course deck should carry no obligation at all: accept public domain / CC0 only.
PD_LICENSE = re.compile(r"(public domain|cc0|pdm|no known copyright|no restrictions|pd-us|pd-self)", re.I)
STOP = set("a an the of in on for with and or map maps image photo picture example showing show".split())
MAX_BYTES = 6 * 1024 * 1024  # a 20 MB scan must not stall the deck build
QUERY_BUDGET_S = 45


def get(url, timeout=20, limit=MAX_BYTES):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        chunks = []
        total = 0
        while True:
            chunk = r.read(262144)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ValueError("image larger than the 6 MB cap")
            chunks.append(chunk)
        return b"".join(chunks)


def terms(query):
    return [t for t in re.split(r"[^a-z0-9]+", query.lower()) if len(t) > 2 and t not in STOP]


def relevant(query, title, extra=""):
    hay = f"{title} {extra}".lower()
    hits = [t for t in terms(query) if t in hay]
    return len(hits) >= 1


def licence_ok(lic, pd_only=False):
    if not lic:
        return not pd_only  # unknown licence is fine for general use, never for pd-only
    if BAD_LICENSE.search(lic):
        return False
    if pd_only:
        return bool(PD_LICENSE.search(lic))
    return True


def score(query, title, extra, width, height):
    t = terms(query)
    hay = f"{title} {extra}".lower()
    hits = sum(1 for x in t if x in hay)
    landscape = 1 if (width and height and width >= height) else 0
    return hits * 2 + landscape


def openverse(query, pd_only=False):
    url = (
        "https://api.openverse.org/v1/images/?q="
        + urllib.parse.quote(query)
        + "&page_size=8&license_type=commercial,modification&mature=false"
    )
    data = json.loads(get(url, 20).decode("utf-8", "ignore"))
    out = []
    for item in data.get("results", []):
        u = item.get("url") or ""
        if not u.lower().split("?")[0].endswith((".jpg", ".jpeg", ".png", ".webp")):
            continue
        title = item.get("title") or ""
        lic = (item.get("license") or "") + (" " + str(item.get("license_version") or ""))
        if not licence_ok(lic, pd_only):
            continue
        if not relevant(query, title):
            continue
        out.append(
            {
                "url": u,
                "title": title or query,
                "creator": item.get("creator") or "unknown",
                "license": lic.strip(),
                "source": item.get("foreign_landing_url") or item.get("source") or "openverse",
                "score": score(query, title, "", item.get("width"), item.get("height")),
            }
        )
    return out


def wikimedia(query, pd_only=False):
    api = (
        "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search"
        "&gsrnamespace=6&gsrlimit=12&gsrsearch="
        + urllib.parse.quote(f"filetype:bitmap {query}")
        + "&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=1200"
    )
    data = json.loads(get(api, 25).decode("utf-8", "ignore"))
    pages = (data.get("query") or {}).get("pages") or {}
    out = []
    for _, page in pages.items():
        info = (page.get("imageinfo") or [{}])[0]
        u = info.get("thumburl") or info.get("url")
        if not u:
            continue
        meta = info.get("extmetadata") or {}
        lic = (meta.get("LicenseShortName") or {}).get("value", "")
        if not licence_ok(lic, pd_only):
            continue
        title = page.get("title", "").replace("File:", "")
        if not relevant(query, title):
            continue
        artist = re.sub(r"<[^>]+>", "", (meta.get("Artist") or {}).get("value", "")) or "unknown"
        out.append(
            {
                "url": u,
                "title": title or query,
                "creator": artist[:80],
                "license": lic or "see Commons page",
                "source": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(page.get("title", "").replace(" ", "_")),
                "score": score(query, title, "", info.get("width"), info.get("height")),
            }
        )
    return out


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "image"


SUPPORTED_FORMATS = ('jpeg', 'png', 'gif', 'bmp', 'tiff')


def normalize_image(path):
    """python-pptx embeds only JPEG/PNG/GIF/BMP/TIFF. Wikimedia serves WEBP thumbs, which raised
    'unsupported image format ... got WEBP' and killed the whole deck build. Convert instead."""
    try:
        from PIL import Image
    except Exception:
        return path
    try:
        with Image.open(path) as im:
            fmt = (im.format or '').lower()
            if fmt in SUPPORTED_FORMATS and im.size[0] <= 1800:
                return path
            out = os.path.splitext(path)[0] + '.png'
            img = im.convert('RGB')
            if img.size[0] > 1800:
                ratio = 1800 / img.size[0]
                img = img.resize((1800, int(img.size[1] * ratio)))
            img.save(out, 'PNG', optimize=True)
        try:
            os.remove(path)
        except OSError:
            pass
        return out
    except Exception:
        return path


def _fetch_once(query, outdir, pd_only=False):
    os.makedirs(outdir, exist_ok=True)
    candidates, errors = [], []
    # Public-domain material overwhelmingly lives on Commons, and the Openverse API is slow, so for
    # pd_only we ask Commons first and only fall back.
    sources = (("wikimedia", wikimedia), ("openverse", openverse)) if pd_only else (("openverse", openverse), ("wikimedia", wikimedia))
    for name, fn in sources:
        try:
            candidates.extend(fn(query, pd_only))
        except Exception as e:
            errors.append(f"{name}: {str(e)[:100]}")
        if candidates:
            break
    if not candidates:
        return {"ok": False, "query": query, "errors": errors, "note": "no licensed, relevant result"}

    candidates.sort(key=lambda c: -c["score"])
    checked = 0
    started = time.time()
    for cand in candidates[:2]:
        if time.time() - started > QUERY_BUDGET_S:
            errors.append("time budget reached")
            break
        checked += 1
        ext = os.path.splitext(cand["url"].split("?")[0])[1].lower() or ".jpg"
        path = os.path.join(outdir, slug(query) + "-" + str(checked) + ext)
        try:
            blob = get(cand["url"], 20)
            if len(blob) < 12000:
                continue
            with open(path, "wb") as f:
                f.write(blob)
        except Exception as e:
            errors.append(f"download: {str(e)[:80]}")
            continue
        path = normalize_image(path)
        credit = f"Image: {cand['title']} — {cand['creator']} ({cand['license']}) {cand['source']}"
        return {"ok": True, "query": query, "file": path, "bytes": len(blob), "credit": credit[:420], "checked": checked}

    return {"ok": False, "query": query, "errors": errors, "note": "candidates existed but none downloaded"}


def fetch(query, outdir, pd_only=False):
    """Try the phrase, then a simplified version: 'choropleth map example' becomes 'choropleth map'."""
    attempts = [query]
    simplified = " ".join(terms(query))
    if simplified and simplified != str(query).strip().lower():
        attempts.append(simplified)
    last = {"ok": False, "query": query, "note": "no attempt ran"}
    for attempt in attempts:
        last = _fetch_once(attempt, outdir, pd_only=pd_only)
        if last.get("ok"):
            last["query_used"] = attempt
            return last
    return last


if __name__ == "__main__":
    if len(sys.argv) < 4 or sys.argv[1] != "fetch":
        print(json.dumps({"error": "usage: images.py fetch <query> <outdir>"}))
    else:
        print(json.dumps(fetch(sys.argv[2], sys.argv[3])))
