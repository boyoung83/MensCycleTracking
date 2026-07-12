"""Generate PWA icons (regular + maskable) for the cycle tracker."""
from PIL import Image, ImageDraw

PINK = (233, 84, 122)      # primary
DEEP = (183, 50, 88)       # drop shade
BG = (255, 240, 244)       # soft background


def draw_drop(size, pad_ratio, bg=True, maskable=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg:
        if maskable:
            d.rectangle([0, 0, size, size], fill=PINK)
        else:
            r = int(size * 0.22)
            d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=PINK)

    # blood drop: circle + triangle top
    cx = size / 2
    scale = 0.62 if maskable else 0.70
    drop_h = size * scale
    top = (size - drop_h) / 2
    bottom = top + drop_h
    radius = drop_h * 0.34
    circle_cy = bottom - radius
    fill = (255, 255, 255, 255)
    # bulb
    d.ellipse([cx - radius, circle_cy - radius, cx + radius, circle_cy + radius], fill=fill)
    # pointed top
    d.polygon([(cx, top), (cx - radius * 0.98, circle_cy + radius * 0.15),
               (cx + radius * 0.98, circle_cy + radius * 0.15)], fill=fill)
    # little highlight
    hr = radius * 0.30
    d.ellipse([cx - radius * 0.35 - hr, circle_cy - hr, cx - radius * 0.35 + hr, circle_cy + hr],
              fill=(255, 220, 228, 255))
    return img


for s in (192, 512):
    draw_drop(s, 0.15).save(f"icon-{s}.png")
    draw_drop(s, 0.15, maskable=True).save(f"icon-{s}-maskable.png")

# apple touch icon
draw_drop(180, 0.15).save("apple-touch-icon.png")
# favicon
draw_drop(64, 0.15).save("favicon.png")
print("icons generated")
