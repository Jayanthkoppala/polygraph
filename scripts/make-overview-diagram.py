#!/usr/bin/env python3
"""
Emits the README's high-level overview diagram in two forms:

  docs/polygraph-overview.excalidraw  — editable source (open in Excalidraw)
  docs/polygraph-overview.svg         — what the README embeds

Two colours only, per the brief: black ground, green ink.
Run: python3 scripts/make-overview-diagram.py
"""
import json
import os

BG = "#000000"
GREEN = "#22C55E"      # primary ink
DIM = "#15803D"        # secondary ink / rules
PALE = "#86EFAC"       # body text

W, H = 1240, 600

# ---------------------------------------------------------------- layout
SCRAPER = (40, 210, 190, 110)
ENGINE = (300, 70, 400, 400)
CHECKS = [
    ("Shape", "every field still there?"),
    ("Consistency", "do the rows agree?"),
    ("Identity", "is this the thing we asked for?"),
    ("Canary", "does a known page still work?"),
]
DECISIONS = [
    ("RELEASE", "the data held up", True),
    ("HOLD", "something is off", False),
    ("REPAIR", "here is the exact fix", False),
    ("REFUSE", "a repair would lie", False),
]
DEC_X, DEC_W, DEC_H = 800, 220, 66
DEC_Y0, DEC_GAP = 78, 100
LEDGER = (40, 510, 1160, 62)


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------- svg
def svg():
    o = []
    a = o.append
    a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
      f'font-family="ui-monospace,SFMono-Regular,Menlo,monospace">')
    a(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
    a(f'<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
      f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{GREEN}"/></marker></defs>')

    def box(x, y, w, h, stroke=DIM, sw=1.5, r=10, fill="none"):
        a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" '
          f'stroke="{stroke}" stroke-width="{sw}"/>')

    def txt(x, y, s, size=14, fill=PALE, anchor="start", weight="normal", ls="0"):
        a(f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" text-anchor="{anchor}" '
          f'font-weight="{weight}" letter-spacing="{ls}">{esc(s)}</text>')

    def arrow(x1, y1, x2, y2):
        a(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{GREEN}" '
          f'stroke-width="1.6" marker-end="url(#a)"/>')

    # 1. the scrapers
    x, y, w, h = SCRAPER
    box(x, y, w, h)
    txt(x + w / 2, y + 42, "YOUR SCRAPERS", 15, GREEN, "middle", "bold", "1")
    txt(x + w / 2, y + 68, "Bright Data", 12, DIM, "middle")
    txt(x + w / 2, y + 86, "collectors", 12, DIM, "middle")

    # scrapers -> engine
    arrow(x + w + 8, y + h / 2, ENGINE[0] - 10, y + h / 2)
    txt((x + w + ENGINE[0]) / 2, y + h / 2 - 14, "200 OK", 13, GREEN, "middle", "bold")
    txt((x + w + ENGINE[0]) / 2, y + h / 2 + 26, "+ JSON", 12, DIM, "middle")

    # 2. the engine
    ex, ey, ew, eh = ENGINE
    box(ex, ey, ew, eh, GREEN, 2, 14)
    txt(ex + ew / 2, ey + 40, "POLYGRAPH", 20, GREEN, "middle", "bold", "2")
    txt(ex + ew / 2, ey + 64, "re-reads the data itself", 12, DIM, "middle")
    a(f'<line x1="{ex + 30}" y1="{ey + 82}" x2="{ex + ew - 30}" y2="{ey + 82}" '
      f'stroke="{DIM}" stroke-width="1"/>')

    cy = ey + 104
    for name, gloss in CHECKS:
        box(ex + 26, cy, ew - 52, 62, DIM, 1, 8)
        txt(ex + 44, cy + 26, name, 14, GREEN, "start", "bold")
        txt(ex + 44, cy + 46, gloss, 11.5, PALE)
        cy += 74

    # 3. the decisions
    for i, (name, gloss, primary) in enumerate(DECISIONS):
        dy = DEC_Y0 + i * DEC_GAP
        box(DEC_X, dy, DEC_W, DEC_H, GREEN if primary else DIM, 2 if primary else 1.5, 10)
        txt(DEC_X + 20, dy + 28, name, 15, GREEN, "start", "bold", "1")
        txt(DEC_X + 20, dy + 49, gloss, 11.5, PALE)
        arrow(ex + ew + 8, ey + eh / 2, DEC_X - 10, dy + DEC_H / 2)

    txt(DEC_X + DEC_W + 18, DEC_Y0 + 3 * DEC_GAP + 30, "← the one", 11.5, GREEN)
    txt(DEC_X + DEC_W + 18, DEC_Y0 + 3 * DEC_GAP + 47, "nobody else does", 11.5, GREEN)

    # 4. the ledger
    lx, ly, lw, lh = LEDGER
    box(lx, ly, lw, lh, GREEN, 1.5, 10)
    txt(lx + 24, ly + 38, "LEDGER", 15, GREEN, "start", "bold", "1")
    txt(lx + 110, ly + 38,
        "every decision, hash-chained to the one before it — change a row and the chain snaps",
        12.5, PALE)
    arrow(DEC_X + DEC_W / 2, DEC_Y0 + 3 * DEC_GAP + DEC_H + 8, DEC_X + DEC_W / 2, ly - 10)

    a("</svg>")
    return "\n".join(o)


# ---------------------------------------------------------------- excalidraw
def exc():
    els, n = [], [0]

    def uid(p):
        n[0] += 1
        return f"{p}{n[0]}"

    def rect(x, y, w, h, stroke=DIM, bold=False):
        els.append({
            "type": "rectangle", "version": 1, "versionNonce": 1, "isDeleted": False,
            "id": uid("r"), "fillStyle": "solid", "strokeWidth": 2 if bold else 1,
            "strokeStyle": "solid", "roughness": 1, "opacity": 100, "angle": 0,
            "x": x, "y": y, "strokeColor": stroke, "backgroundColor": "transparent",
            "width": w, "height": h, "seed": 1, "groupIds": [], "frameId": None,
            "roundness": {"type": 3}, "boundElements": [], "updated": 1, "link": None, "locked": False,
        })

    def text(x, y, s, size=16, color=PALE, bold=False):
        els.append({
            "type": "text", "version": 1, "versionNonce": 1, "isDeleted": False,
            "id": uid("t"), "fillStyle": "solid", "strokeWidth": 1, "strokeStyle": "solid",
            "roughness": 1, "opacity": 100, "angle": 0, "x": x, "y": y,
            "strokeColor": color, "backgroundColor": "transparent",
            "width": max(10, len(s) * size * 0.6), "height": size * 1.25, "seed": 1,
            "groupIds": [], "frameId": None, "roundness": None, "boundElements": [],
            "updated": 1, "link": None, "locked": False, "text": s, "fontSize": size,
            "fontFamily": 3, "textAlign": "left", "verticalAlign": "top",
            "containerId": None, "originalText": s, "lineHeight": 1.25,
        })

    def arrow(x1, y1, x2, y2):
        els.append({
            "type": "arrow", "version": 1, "versionNonce": 1, "isDeleted": False,
            "id": uid("a"), "fillStyle": "solid", "strokeWidth": 1, "strokeStyle": "solid",
            "roughness": 1, "opacity": 100, "angle": 0, "x": x1, "y": y1,
            "strokeColor": GREEN, "backgroundColor": "transparent",
            "width": x2 - x1, "height": y2 - y1, "seed": 1, "groupIds": [], "frameId": None,
            "roundness": {"type": 2}, "boundElements": [], "updated": 1, "link": None,
            "locked": False, "points": [[0, 0], [x2 - x1, y2 - y1]], "lastCommittedPoint": None,
            "startBinding": None, "endBinding": None, "startArrowhead": None, "endArrowhead": "arrow",
        })

    x, y, w, h = SCRAPER
    rect(x, y, w, h)
    text(x + 24, y + 32, "YOUR SCRAPERS", 16, GREEN, True)
    text(x + 24, y + 62, "Bright Data collectors", 12, DIM)
    arrow(x + w + 8, y + h / 2, ENGINE[0] - 10, y + h / 2)
    text(x + w + 26, y + h / 2 - 30, "200 OK", 14, GREEN, True)

    ex, ey, ew, eh = ENGINE
    rect(ex, ey, ew, eh, GREEN, True)
    text(ex + 110, ey + 22, "POLYGRAPH", 22, GREEN, True)
    text(ex + 96, ey + 52, "re-reads the data itself", 12, DIM)
    cy = ey + 104
    for name, gloss in CHECKS:
        rect(ex + 26, cy, ew - 52, 62)
        text(ex + 44, cy + 12, name, 15, GREEN, True)
        text(ex + 44, cy + 34, gloss, 11, PALE)
        cy += 74

    for i, (name, gloss, primary) in enumerate(DECISIONS):
        dy = DEC_Y0 + i * DEC_GAP
        rect(DEC_X, dy, DEC_W, DEC_H, GREEN if primary else DIM, primary)
        text(DEC_X + 20, dy + 14, name, 16, GREEN, True)
        text(DEC_X + 20, dy + 38, gloss, 11, PALE)
        arrow(ex + ew + 8, ey + eh / 2, DEC_X - 10, dy + DEC_H / 2)

    lx, ly, lw, lh = LEDGER
    rect(lx, ly, lw, lh, GREEN)
    text(lx + 24, ly + 20, "LEDGER", 16, GREEN, True)
    text(lx + 130, ly + 22, "every decision, hash-chained — change a row and the chain snaps", 12, PALE)
    arrow(DEC_X + DEC_W / 2, DEC_Y0 + 3 * DEC_GAP + DEC_H + 8, DEC_X + DEC_W / 2, ly - 10)

    return {
        "type": "excalidraw", "version": 2, "source": "polygraph",
        "elements": els,
        "appState": {"gridSize": None, "viewBackgroundColor": BG},
        "files": {},
    }


root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
docs = os.path.join(root, "docs")
os.makedirs(docs, exist_ok=True)

with open(os.path.join(docs, "polygraph-overview.svg"), "w") as f:
    f.write(svg())
with open(os.path.join(docs, "polygraph-overview.excalidraw"), "w") as f:
    json.dump(exc(), f, indent=1)

print("wrote docs/polygraph-overview.svg and docs/polygraph-overview.excalidraw")
