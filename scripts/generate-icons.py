from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SIZE = 1024


def cubic(p0, p1, p2, p3, steps=40):
    points = []
    for index in range(steps + 1):
        t = index / steps
        inverse = 1 - t
        x = (
            inverse**3 * p0[0]
            + 3 * inverse**2 * t * p1[0]
            + 3 * inverse * t**2 * p2[0]
            + t**3 * p3[0]
        )
        y = (
            inverse**3 * p0[1]
            + 3 * inverse**2 * t * p1[1]
            + 3 * inverse * t**2 * p2[1]
            + t**3 * p3[1]
        )
        points.append((round(x), round(y)))
    return points


def make_icon():
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image, "RGBA")

    draw.ellipse((215, 790, 810, 930), fill=(21, 54, 60, 55))

    top = (512, 72)
    right = cubic(top, (585, 225), (808, 425), (804, 650))
    bottom_right = cubic((804, 650), (808, 820), (670, 918), (512, 918))
    bottom_left = cubic((512, 918), (354, 918), (216, 820), (220, 650))
    left = cubic((220, 650), (216, 425), (439, 225), top)
    body = right + bottom_right[1:] + bottom_left[1:] + left[1:]
    draw.polygon(body, fill=(23, 135, 154, 255))

    draw.ellipse((332, 260, 450, 485), fill=(114, 207, 218, 150))
    draw.ellipse((348, 624, 425, 678), fill=(223, 102, 88, 210))
    draw.ellipse((599, 624, 676, 678), fill=(223, 102, 88, 210))
    draw.ellipse((389, 566, 415, 596), fill=(255, 255, 255, 255))
    draw.ellipse((609, 566, 635, 596), fill=(255, 255, 255, 255))

    mouth = []
    for angle in range(15, 166, 4):
        radians = math.radians(angle)
        mouth.append((512 + int(93 * math.cos(radians)), 598 + int(80 * math.sin(radians))))
    draw.line(mouth, fill=(255, 255, 255, 255), width=28, joint="curve")

    return image


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    icon = make_icon()
    icon.save(ASSETS / "icon.png", optimize=True)
    icon.save(
        ASSETS / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    icon.resize((32, 32), Image.Resampling.LANCZOS).save(ASSETS / "tray.png", optimize=True)


if __name__ == "__main__":
    main()
