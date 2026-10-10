"""Draws the Wovenpage application icon and writes build/icon.ico and build/icon.png.

The mark is original artwork: two weft threads crossing two warp threads,
passing over one and under the next. Run with:  python scripts/make-icon.py
(requires Pillow). The outputs are committed, so this only needs running if
the mark changes.
"""

from pathlib import Path
from PIL import Image, ImageDraw

ACCENT = (51, 70, 200, 255)
WEFT = (255, 255, 255, 255)
WARP = (153, 163, 228, 255)  # white at 50% over the accent
SCALE = 8  # supersampling factor


def draw(size: int) -> Image.Image:
    s = size * SCALE
    unit = s / 44  # the mark is designed on a 44-unit grid
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=9 * unit, fill=ACCENT)

    def thread(x1, y1, x2, y2, colour, width=5.0):
        w = width * unit
        if x1 == x2:
            box = [x1 * unit - w / 2, y1 * unit - w / 2, x1 * unit + w / 2, y2 * unit + w / 2]
        else:
            box = [x1 * unit - w / 2, y1 * unit - w / 2, x2 * unit + w / 2, y1 * unit + w / 2]
        d.rounded_rectangle(box, radius=w / 2, fill=colour)

    def gap(x, y1, y2):
        w = 9 * unit
        d.rectangle([x * unit - w / 2, y1 * unit, x * unit + w / 2, y2 * unit], fill=ACCENT)

    # warp (vertical) underneath, weft (horizontal) on top
    thread(15, 9, 15, 35, WARP)
    thread(29, 9, 29, 35, WARP)
    thread(9, 16, 35, 16, WEFT)
    thread(9, 28, 35, 28, WEFT)
    # at two of the four crossings the warp passes over instead
    gap(15, 22.5, 33.5)
    thread(15, 21, 15, 35, WARP)
    gap(29, 10.5, 21.5)
    thread(29, 9, 29, 23, WARP)
    return img.resize((size, size), Image.LANCZOS)


out = Path(__file__).resolve().parent.parent / "build"
out.mkdir(exist_ok=True)
draw(512).save(out / "icon.png")
# Small sizes are stored as classic bitmaps (the most widely accepted form); Pillow keeps 256 px as PNG.
draw(256).save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)], bitmap_format="bmp")
print("wrote", out / "icon.ico", "and", out / "icon.png")
