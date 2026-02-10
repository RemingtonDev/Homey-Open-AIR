"""Generate app store images for Homey Open AIR with airflow/breeze icon."""
import math
from PIL import Image, ImageDraw, ImageFont

# --- Colours ---
BG_DARK = (30, 47, 60)       # dark teal
BG_MID = (36, 58, 74)        # slightly lighter teal
GREEN = (46, 204, 113)        # #2ECC71 brand colour
ICON_WHITE = (220, 225, 230)  # light grey-white for icon
LINE_DIM = (50, 75, 90)       # dim decorative lines
DOT_DIM = (55, 80, 95)        # dim grid dots
TEXT_COL = (160, 185, 200)     # muted light blue text
GREEN_DIM = (46, 204, 113, 60) # green with alpha for glow


def draw_breeze_curve(draw, points, width, color):
    """Draw a smooth curve through given control points using line segments."""
    # Simple cubic bezier renderer using de Casteljau
    steps = 80
    def cubic_bezier(p0, p1, p2, p3, t):
        u = 1 - t
        return (
            u**3 * p0[0] + 3*u**2*t * p1[0] + 3*u*t**2 * p2[0] + t**3 * p3[0],
            u**3 * p0[1] + 3*u**2*t * p1[1] + 3*u*t**2 * p2[1] + t**3 * p3[1],
        )

    # Each curve has two cubic bezier segments
    # points = [start, cp1, cp2, mid, cp3, cp4, end]
    all_pts = []
    # First segment: start -> mid
    for i in range(steps + 1):
        t = i / steps
        pt = cubic_bezier(points[0], points[1], points[2], points[3], t)
        all_pts.append(pt)
    # Second segment: mid -> end
    for i in range(1, steps + 1):
        t = i / steps
        pt = cubic_bezier(points[3], points[4], points[5], points[6], t)
        all_pts.append(pt)

    # Draw as connected line segments
    for i in range(len(all_pts) - 1):
        draw.line([all_pts[i], all_pts[i+1]], fill=color, width=width)


def draw_icon(draw, cx, cy, size, color, line_widths):
    """Draw the breeze/airflow icon centered at (cx, cy) with given size."""
    s = size / 100.0  # scale factor

    # Three curves matching the SVG paths, centered at (cx, cy)
    # SVG center is roughly (52, 50), offset = cx-52*s, cy-50*s
    ox = cx - 52 * s
    oy = cy - 50 * s

    curves = [
        # Top curve: M 18 30 C 30 18, 44 42, 56 30 C 68 18, 80 34, 90 26
        [(18, 30), (30, 18), (44, 42), (56, 30), (68, 18), (80, 34), (90, 26)],
        # Middle curve: M 10 50 C 24 36, 40 64, 54 50 C 68 36, 82 56, 94 46
        [(10, 50), (24, 36), (40, 64), (54, 50), (68, 36), (82, 56), (94, 46)],
        # Bottom curve: M 18 70 C 30 58, 44 82, 56 70 C 68 58, 80 74, 90 66
        [(18, 70), (30, 58), (44, 82), (56, 70), (68, 58), (80, 74), (90, 66)],
    ]

    for idx, curve in enumerate(curves):
        scaled = [(ox + p[0] * s, oy + p[1] * s) for p in curve]
        draw_breeze_curve(draw, scaled, line_widths[idx], color)


def draw_decorative_wave(draw, y_base, amplitude, wavelength, x_start, x_end, color, width):
    """Draw a gentle sine wave as decoration."""
    pts = []
    for x in range(int(x_start), int(x_end), 2):
        y = y_base + amplitude * math.sin(2 * math.pi * (x - x_start) / wavelength)
        pts.append((x, y))
    for i in range(len(pts) - 1):
        draw.line([pts[i], pts[i+1]], fill=color, width=width)


def draw_grid_dots(draw, x, y, rows, cols, spacing, color, radius):
    """Draw a grid of small dots."""
    for r in range(rows):
        for c in range(cols):
            cx = x + c * spacing
            cy = y + r * spacing
            draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=color)


def generate_image(width, height, filename):
    """Generate a single app store image."""
    img = Image.new('RGBA', (width, height), BG_DARK)
    draw = ImageDraw.Draw(img)

    scale = width / 1000.0  # normalize to xlarge

    # --- Background gradient (simple vertical) ---
    for y in range(height):
        t = y / height
        r = int(BG_DARK[0] * (1 - t * 0.15) + BG_MID[0] * t * 0.15)
        g = int(BG_DARK[1] * (1 - t * 0.15) + BG_MID[1] * t * 0.15)
        b = int(BG_DARK[2] * (1 - t * 0.15) + BG_MID[2] * t * 0.15)
        draw.line([(0, y), (width, y)], fill=(r, g, b))

    # --- Grid lines (very subtle) ---
    grid_color = (35, 55, 68)
    grid_spacing = int(70 * scale)
    if grid_spacing > 0:
        for x in range(0, width, grid_spacing):
            draw.line([(x, 0), (x, height)], fill=grid_color, width=1)
        for y in range(0, height, grid_spacing):
            draw.line([(0, y), (width, y)], fill=grid_color, width=1)

    # --- Grid dots in corners ---
    dot_r = max(2, int(3 * scale))
    dot_spacing = int(18 * scale)
    # Top-left
    draw_grid_dots(draw, int(55 * scale), int(45 * scale), 3, 3, dot_spacing, DOT_DIM, dot_r)
    # Top-right
    draw_grid_dots(draw, width - int(100 * scale), int(45 * scale), 3, 3, dot_spacing, DOT_DIM, dot_r)

    # --- Decorative wavy lines in middle background ---
    wave_y_base = height * 0.52
    for i, offset in enumerate([-40, -15, 12, 38, 62]):
        amp = 12 * scale + i * 2 * scale
        wl = 350 * scale + i * 50 * scale
        draw_decorative_wave(
            draw,
            wave_y_base + offset * scale,
            amp,
            wl,
            30 * scale,
            width - 30 * scale,
            LINE_DIM,
            max(1, int(1.5 * scale)),
        )

    # --- Green glow under icon ---
    glow_img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_img)
    glow_cx = width // 2
    glow_cy = int(height * 0.46 + 45 * scale)
    glow_rx = int(90 * scale)
    glow_ry = int(30 * scale)
    for r in range(20, 0, -1):
        alpha = int(8 * (20 - r))
        ex = glow_rx + r * 3 * scale
        ey = glow_ry + r * 1 * scale
        glow_draw.ellipse(
            [glow_cx - ex, glow_cy - ey, glow_cx + ex, glow_cy + ey],
            fill=(46, 204, 113, min(alpha, 50)),
        )
    img = Image.alpha_composite(img, glow_img)
    draw = ImageDraw.Draw(img)

    # --- Main icon ---
    icon_cx = width // 2
    icon_cy = int(height * 0.40)
    icon_size = 160 * scale
    icon_lw = [max(2, int(5 * scale)), max(2, int(4 * scale)), max(1, int(3.2 * scale))]
    draw_icon(draw, icon_cx, icon_cy, icon_size, ICON_WHITE, icon_lw)

    # --- Sensor readings at bottom ---
    text_y = int(height * 0.76)
    try:
        font_size = max(10, int(16 * scale))
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
        small_font_size = max(8, int(12 * scale))
        small_font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", small_font_size)
    except (OSError, IOError):
        font = ImageFont.load_default()
        small_font = font

    readings = [
        ("22.4\u00b0C", GREEN),
        ("58.2%", GREEN),
        ("CO\u2082  412 ppm", GREEN),
        ("VOC  Index 98", GREEN),
    ]
    section_w = width / len(readings)
    for i, (text, color) in enumerate(readings):
        tx = int(section_w * i + section_w / 2)
        # Use textbbox for centering
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        draw.text((tx - tw // 2, text_y), text, fill=TEXT_COL, font=font)

    # --- Green progress bar at bottom ---
    bar_y = int(height * 0.84)
    bar_h = max(2, int(4 * scale))
    bar_w = int(250 * scale)
    bar_x = (width - bar_w) // 2
    # Background track
    draw.rounded_rectangle(
        [bar_x, bar_y, bar_x + bar_w, bar_y + bar_h],
        radius=bar_h // 2,
        fill=(40, 60, 75),
    )
    # Green fill (about 60%)
    fill_w = int(bar_w * 0.6)
    draw.rounded_rectangle(
        [bar_x, bar_y, bar_x + fill_w, bar_y + bar_h],
        radius=bar_h // 2,
        fill=GREEN,
    )

    # --- Save ---
    img_rgb = Image.new('RGB', img.size, BG_DARK)
    img_rgb.paste(img, mask=img.split()[3])
    img_rgb.save(filename, 'PNG')
    print(f"  Saved {filename} ({width}x{height})")


if __name__ == '__main__':
    base = '/Users/julienmoysens/Library/CloudStorage/OneDrive-Personal/Dev/Homey-Open-AIR/assets/images'
    print("Generating app store images...")
    generate_image(250, 175, f'{base}/small.png')
    generate_image(500, 350, f'{base}/large.png')
    generate_image(1000, 700, f'{base}/xlarge.png')
    print("Done!")
