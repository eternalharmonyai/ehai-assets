"""
╔══════════════════════════════════════════════════════════════════╗
║  BRAND ASSET GENERATOR                                          ║
║  Drop-in Python script for favicons + OG banner generation      ║
╚══════════════════════════════════════════════════════════════════╝

Generates from a single logo image:
  - favicon-16.png, favicon-32.png (browser tabs)
  - apple-touch-icon.png (180x180, iOS home screen)
  - icon-192.png, icon-512.png (Android/PWA)
  - favicon.ico (multi-res 16, 32, 48)
  - og-banner.jpg (1200x630, social sharing)

WHAT TO CUSTOMIZE (search for 🔧 PLACEHOLDER):
  1. BRAND_NAME        — your brand name
  2. TAGLINE           — short description
  3. DOMAIN            — your website URL (shown on OG banner)
  4. COLORS            — teal, gold, warm-white (or your palette)
  5. LOGO_PATH         — path to your logo PNG (should have transparency)

REQUIREMENTS:
  pip install Pillow

USAGE:
  python brand-assets.py

ORIGIN: Extracted from jeantobin.com brand pipeline (Eternal Harmony, 2026)
LICENSE: Free to reuse — built by Eternal Harmony AI
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import os

# ═══════════════════════════════════════════════════════════════
# 🔧 PLACEHOLDER — Customize these for your brand
# ═══════════════════════════════════════════════════════════════

BRAND_NAME = "🔧 Your Brand Name"
TAGLINE = "🔧 Your tagline or subtitle"
DOMAIN = "🔧 yoursite.com"

# Your brand colors (RGB tuples)
COLOR_PRIMARY      = (42, 157, 143)   # 🔧 Teal / main brand color
COLOR_PRIMARY_DEEP = (27, 122, 112)   # 🔧 Darker variant
COLOR_PRIMARY_DARK = (14, 60, 56)     # 🔧 Very dark for gradients
COLOR_ACCENT       = (242, 183, 49)   # 🔧 Gold / accent
COLOR_LIGHT        = (255, 255, 255)  # 🔧 White / light background

# Path to your logo (should be a PNG with transparency)
LOGO_PATH = Path("🔧 your-logo.png")

# Output directory (defaults to current working directory)
OUTPUT_DIR = Path(".")


# ═══════════════════════════════════════════════════════════════
# INTERNALS — No need to modify below
# ═══════════════════════════════════════════════════════════════

def load_logo():
    if not LOGO_PATH.exists():
        raise FileNotFoundError(f"Logo not found: {LOGO_PATH.resolve()}\n  Update LOGO_PATH at the top of this script.")
    return Image.open(LOGO_PATH).convert("RGBA")


def square_with_padding(src, size, pad_ratio=0.08, bg=None):
    """Place src centered on a square canvas."""
    canvas = Image.new("RGBA", (size, size), bg if bg else (0, 0, 0, 0))
    inner = int(size * (1 - 2 * pad_ratio))
    resized = src.copy()
    resized.thumbnail((inner, inner), Image.LANCZOS)
    x = (size - resized.width) // 2
    y = (size - resized.height) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas


def gen_favicons():
    """Generate all favicon sizes + .ico."""
    logo = load_logo()
    output = OUTPUT_DIR

    sizes = {
        "favicon-16.png": 16,
        "favicon-32.png": 32,
        "apple-touch-icon.png": 180,
        "icon-192.png": 192,
        "icon-512.png": 512,
    }
    for name, sz in sizes.items():
        # iOS needs solid background (strips alpha)
        bg = COLOR_LIGHT + (255,) if name == "apple-touch-icon.png" else None
        img = square_with_padding(logo, sz, pad_ratio=0.06 if sz >= 192 else 0.10, bg=bg)
        img.save(output / name, "PNG", optimize=True)
        print(f"  ✓ {name}  ({sz}×{sz})")

    # Multi-resolution .ico
    base = square_with_padding(logo, 48, pad_ratio=0.08)
    base.save(output / "favicon.ico", format="ICO", sizes=[(16,16),(32,32),(48,48)])
    print(f"  ✓ favicon.ico  (16,32,48)")


def linear_gradient(size, top_color, bottom_color):
    """Render a vertical linear gradient."""
    w, h = size
    grad = Image.new("RGB", (1, h), 0)
    for y in range(h):
        t = y / max(h - 1, 1)
        r = int(top_color[0]*(1-t) + bottom_color[0]*t)
        g = int(top_color[1]*(1-t) + bottom_color[1]*t)
        b = int(top_color[2]*(1-t) + bottom_color[2]*t)
        grad.putpixel((0, y), (r, g, b))
    return grad.resize((w, h), Image.LANCZOS)


def find_font(size, italic=False, bold=False, sans=False):
    """Find a system font that matches the requested style."""
    if italic:
        candidates = ["C:/Windows/Fonts/georgiai.ttf", "C:/Windows/Fonts/timesi.ttf"]
    elif bold and sans:
        candidates = ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf"]
    elif sans:
        candidates = ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"]
    else:
        candidates = ["C:/Windows/Fonts/georgia.ttf", "C:/Windows/Fonts/times.ttf"]

    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def gen_og_banner():
    """Generate 1200×630 social sharing image (OG:Image)."""
    logo = load_logo()
    output = OUTPUT_DIR
    W, H = 1200, 630

    # Gradient background
    bg = linear_gradient((W, H), COLOR_PRIMARY_DEEP, COLOR_PRIMARY_DARK).convert("RGBA")

    # Faint logo watermark on the right
    wm = logo.copy()
    wm.thumbnail((720, 720), Image.LANCZOS)
    alpha = wm.split()[3]
    alpha = alpha.point(lambda p: int(p * 0.22))
    wm.putalpha(alpha)
    bg.alpha_composite(wm, (W - wm.width + 80, (H - wm.height) // 2))

    # Solid logo mark on the left
    mark = logo.copy()
    mark.thumbnail((300, 300), Image.LANCZOS)
    bg.alpha_composite(mark, (60, (H - mark.height) // 2 - 40))

    draw = ImageDraw.Draw(bg)

    # 🔧 Eyebrow text (optional — comment out if not wanted)
    eyebrow_font = find_font(22, bold=True, sans=True)
    draw.text((380, 175), TAGLINE.upper() if TAGLINE else "",
              font=eyebrow_font, fill=(180, 230, 222, 255))

    # Brand name
    title_font = find_font(82, italic=True)
    draw.text((380, 215), BRAND_NAME, font=title_font, fill=COLOR_LIGHT + (255,))

    # Tagline
    if TAGLINE:
        sub_font = find_font(28, sans=True)
        lines = TAGLINE.split("\n")
        for i, line in enumerate(lines[:2]):
            draw.text((380, 335 + i * 40), line, font=sub_font, fill=(220, 245, 240, 255))

    # Domain pill
    pill_font = find_font(26, bold=True, sans=True)
    pill_text = DOMAIN
    pad_x, pad_y = 26, 12
    bbox = draw.textbbox((0, 0), pill_text, font=pill_font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pill_w, pill_h = tw + pad_x * 2, th + pad_y * 2
    px, py = 380, 470
    draw.rounded_rectangle(
        [(px, py), (px + pill_w, py + pill_h)],
        radius=pill_h // 2,
        fill=COLOR_ACCENT + (255,)
    )
    draw.text((px + pad_x, py + pad_y - 4), pill_text, font=pill_font, fill=(30, 30, 30, 255))

    # Gold accent line under name
    draw.rounded_rectangle([(380, 312), (480, 318)], radius=3, fill=COLOR_ACCENT + (255,))

    out = bg.convert("RGB")
    out.save(output / "og-banner.jpg", "JPEG", quality=88, optimize=True, progressive=True)
    print(f"  ✓ og-banner.jpg  (1200×630)")


if __name__ == "__main__":
    print(f"\n  Generating brand assets for: {BRAND_NAME}\n")
    print("Favicons:")
    gen_favicons()
    print("\nOG Banner:")
    gen_og_banner()
    print(f"\n  ✓ All assets written to: {OUTPUT_DIR.resolve()}\n")
