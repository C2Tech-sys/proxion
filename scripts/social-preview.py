"""Builds docs/brand/social-preview.png (1280x640), the image to upload under
GitHub repo Settings -> Social preview. Needs Pillow and an installed workspace
(the brand fonts come from node_modules).  Usage: python scripts/social-preview.py .
"""
import sys, glob
from PIL import Image, ImageDraw, ImageFont
root = sys.argv[1]
J = glob.glob(root + '/node_modules/.pnpm/@fontsource-variable+josefin-sans@*/node_modules/@fontsource-variable/josefin-sans/files/josefin-sans-latin-wght-normal.woff2')[0]
O = glob.glob(root + '/node_modules/.pnpm/@fontsource-variable+open-sans@*/node_modules/@fontsource-variable/open-sans/files/open-sans-latin-wght-normal.woff2')[0]
def font(p, size, wght):
    f = ImageFont.truetype(p, size)
    axes = f.get_variation_axes()
    vals = [wght if a['name'] in (b'Weight', 'Weight') else a['default'] for a in axes]
    f.set_variation_by_axes(vals); return f
W, H = 1280, 640
BG = (9, 9, 11)
im = Image.new('RGB', (W, H), BG)
# screenshot, right side, bleeding off the right and bottom edges
shot = Image.open(root + '/docs/screenshots/dashboard-dark.png').convert('RGB')
sw = 880; sh = round(shot.height * sw / shot.width)
shot = shot.resize((sw, sh), Image.LANCZOS)
x0, y0, r = 628, 150, 14
mask = Image.new('L', (sw, sh), 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw + r, sh + r), r, fill=255)
im.paste(shot, (x0, y0), mask)
d = ImageDraw.Draw(im)
d.rounded_rectangle((x0, y0, x0 + sw + r, y0 + sh + r), r, outline=(63, 63, 70), width=2)
# fade the screenshot into the background at the right edge and bottom
fade = Image.new('RGBA', (W, H), (0, 0, 0, 0)); fd = ImageDraw.Draw(fade)
for i in range(140):
    a = round(255 * (i / 139) ** 2)
    fd.line((0, H - 140 + i, W, H - 140 + i), fill=BG + (a,))
im = Image.alpha_composite(im.convert('RGBA'), fade).convert('RGB'); d = ImageDraw.Draw(im)
# lockup
lock = Image.open(root + '/docs/brand/lockup-dark.png').convert('RGB')
lw = 400; lh = round(lock.height * lw / lock.width)
lock = lock.resize((lw, lh), Image.LANCZOS)
im.paste(lock, (36, 96))
# text
X = 76
h1 = font(J, 50, 400)
y = 250
for line in ['A modern web console', 'for Proxmox VE']:
    d.text((X, y), line, font=h1, fill=(244, 244, 245)); y += 62
sub = font(O, 23, 400)
y += 22
for line in ['Live dashboard with console thumbnails,', 'vSphere-style VM and node pages,', 'console and terminal in the browser.']:
    d.text((X, y), line, font=sub, fill=(161, 161, 170)); y += 34
tag = font(O, 20, 600)
d.text((X, 552), 'Open source  ·  Self-hosted  ·  Apache-2.0', font=tag, fill=(34, 184, 184))
im.save(root + '/docs/brand/social-preview.png', optimize=True)
print(im.size)
