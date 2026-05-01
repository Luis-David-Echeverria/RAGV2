"""PIL-generated tray icons. Stellium visual language: a 4-pointed star with halo."""
from __future__ import annotations

import math
from io import BytesIO

from PIL import Image, ImageDraw
from PySide6.QtGui import QIcon, QPixmap

ICON_SIZE = 64


def _star_polygon(cx: float, cy: float, r_outer: float, r_inner: float, points: int = 4) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for i in range(points * 2):
        angle = -math.pi / 2 + (math.pi * i) / points
        r = r_outer if i % 2 == 0 else r_inner
        pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return pts


def _render_icon(core: tuple[int, int, int], halo: tuple[int, int, int], halo_alpha: int = 90) -> Image.Image:
    img = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    cx = cy = ICON_SIZE / 2
    halo_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    halo_draw = ImageDraw.Draw(halo_layer)
    for i, (mult, alpha_mult) in enumerate([(0.95, 0.5), (0.78, 0.85), (0.6, 1.0)]):
        r_o = (ICON_SIZE * 0.46) * mult
        r_i = r_o * 0.38
        a = int(halo_alpha * alpha_mult)
        halo_draw.polygon(_star_polygon(cx, cy, r_o, r_i), fill=(*halo, a))
    img = Image.alpha_composite(img, halo_layer)

    draw = ImageDraw.Draw(img)
    draw.polygon(_star_polygon(cx, cy, ICON_SIZE * 0.27, ICON_SIZE * 0.10), fill=(*core, 255))
    draw.ellipse(
        [cx - ICON_SIZE * 0.07, cy - ICON_SIZE * 0.07, cx + ICON_SIZE * 0.07, cy + ICON_SIZE * 0.07],
        fill=(255, 255, 255, 230),
    )
    return img


def _to_qicon(img: Image.Image) -> QIcon:
    buf = BytesIO()
    img.save(buf, format="PNG")
    pix = QPixmap()
    pix.loadFromData(buf.getvalue(), "PNG")
    return QIcon(pix)


def idle_icon() -> QIcon:
    return _to_qicon(_render_icon((255, 255, 255), (176, 196, 255)))


def working_icon(phase: float = 0.0) -> QIcon:
    """phase in [0, 1] — pulsing halo intensity for the working animation."""
    a = int(60 + 100 * (0.5 + 0.5 * math.sin(phase * 2 * math.pi)))
    return _to_qicon(_render_icon((140, 232, 200), (0, 232, 160), halo_alpha=a))


def error_icon() -> QIcon:
    return _to_qicon(_render_icon((255, 90, 90), (255, 0, 64)))
