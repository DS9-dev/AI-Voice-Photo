"""AI Voice Photo app icon (original artwork, drawn in code).

macOS-style squircle with a soft violet-to-rose gradient, a white portrait card with a
face silhouette, and two voice waves. Drawn at 4x and downsampled, so it stays clean at
16 px. Writes icon.png (1024), icon_256.png and icon.ico (16-256) next to this file.

  python app/assets/make_icon.py        (needs Pillow + NumPy)
"""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
S = 4096          # working size (4x of 1024)


def squircle_mask(size, n=5.0, inset=0.0):
    """Superellipse |x|^n + |y|^n <= 1 (the macOS app-icon shape)."""
    r = (size / 2) * (1 - inset)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    x = (xx - size / 2 + 0.5) / r
    y = (yy - size / 2 + 0.5) / r
    v = np.abs(x) ** n + np.abs(y) ** n
    return Image.fromarray((np.clip((1.0 - v) * size * 0.02 + 0.5, 0, 1) * 255).astype(np.uint8))


def gradient(size):
    """Diagonal violet -> rose gradient with a soft light from the top-left."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    t = np.clip((xx * 0.55 + yy * 0.75) / 1.3, 0, 1)[..., None]
    c0 = np.array([88, 86, 214], np.float32)    # indigo-violet
    c1 = np.array([168, 92, 236], np.float32)   # violet
    c2 = np.array([255, 110, 150], np.float32)  # rose
    col = np.where(t < 0.55, c0 + (c1 - c0) * (t / 0.55), c1 + (c2 - c1) * ((t - 0.55) / 0.45))
    glow = np.exp(-(((xx - 0.28) / 0.45) ** 2 + ((yy - 0.18) / 0.35) ** 2))[..., None]
    col = col + (255 - col) * 0.22 * glow
    return Image.fromarray(np.clip(col, 0, 255).astype(np.uint8), "RGB")


def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)


def build():
    base = gradient(S).convert("RGBA")
    mask = squircle_mask(S, inset=0.08)            # standard icon margin
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)

    # portrait card (slightly left of centre) with a soft shadow
    cw, ch = int(S * 0.40), int(S * 0.50)
    cx, cy = int(S * 0.40), int(S * 0.51)
    box = (cx - cw // 2, cy - ch // 2, cx + cw // 2, cy + ch // 2)
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((box[0] + S * 0.012, box[1] + S * 0.03, box[2] + S * 0.012, box[3] + S * 0.03),
                                             radius=int(S * 0.07), fill=(40, 10, 70, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.025))
    icon = Image.alpha_composite(icon, shadow)
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rounded(d, box, int(S * 0.07), (255, 255, 255, 255))
    # face silhouette inside the card: head + shoulders, in the icon's violet
    inner = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    di = ImageDraw.Draw(inner)
    sil = (122, 96, 230, 255)
    hr = int(S * 0.085)
    hx, hy = cx, cy - int(ch * 0.10)
    di.ellipse((hx - hr, hy - hr, hx + hr, hy + hr), fill=sil)
    sw = int(cw * 0.78)
    di.ellipse((cx - sw // 2, hy + int(hr * 1.25), cx + sw // 2, hy + int(hr * 1.25) + int(sw * 0.95)), fill=sil)
    clip = Image.new("L", (S, S), 0)
    ImageDraw.Draw(clip).rounded_rectangle((box[0] + S * 0.02, box[1] + S * 0.02, box[2] - S * 0.02, box[3] - S * 0.02), radius=int(S * 0.055), fill=255)
    layer.paste(inner, (0, 0), Image.fromarray(np.minimum(np.array(inner.split()[3]), np.array(clip))))
    icon = Image.alpha_composite(icon, layer)

    # two voice waves to the right of the card
    waves = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dw = ImageDraw.Draw(waves)
    wx, wy = box[2] + int(S * 0.02), cy
    for i, (rad, alpha) in enumerate(((0.10, 255), (0.17, 200))):
        r = int(S * rad)
        dw.arc((wx - r, wy - r, wx + r, wy + r), start=-48, end=48, fill=(255, 255, 255, alpha), width=int(S * 0.034))
    icon = Image.alpha_composite(icon, waves)
    return icon


def main():
    big = build().resize((1024, 1024), Image.LANCZOS)
    big.save(os.path.join(HERE, "icon.png"))
    big.resize((256, 256), Image.LANCZOS).save(os.path.join(HERE, "icon_256.png"))
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    big.save(os.path.join(HERE, "icon.ico"), sizes=sizes)
    print("icon.png, icon_256.png, icon.ico written")


if __name__ == "__main__":
    main()
