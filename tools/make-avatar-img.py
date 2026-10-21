#!/usr/bin/env python3
"""Make the round-screen avatar picture and (optionally) put it on the home gateway.

  make-avatar-img.py photo.jpg                 -> writes photo.mav (233x233 RGB565 with a 16-byte header)
  GW_AVATAR_URL='http://HOST:8787/avatar/set?k=TOKEN' make-avatar-img.py photo.jpg --upload

The picture is cropped to a centred square, scaled to 233x233 and the corners outside the circle are made black.
Then on the device: Settings > Avatar > Get picture, and choose Picture.
"""
import os, struct, sys, urllib.request
from PIL import Image, ImageDraw, ImageOps

SIZE = 233

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    src = args[0]
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    im = ImageOps.fit(im, (SIZE, SIZE), Image.LANCZOS, centering=(0.5, 0.4))
    mask = Image.new("L", (SIZE * 4, SIZE * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, SIZE * 4 - 1, SIZE * 4 - 1), fill=255)
    mask = mask.resize((SIZE, SIZE), Image.LANCZOS)
    black = Image.new("RGB", (SIZE, SIZE), (0, 0, 0))
    im = Image.composite(im, black, mask)
    px = bytearray()
    for r, g, b in im.getdata():
        v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
        px += struct.pack("<H", v)
    data = struct.pack("<IHHII", 0x3156414D, SIZE, SIZE, len(px), 0) + bytes(px)
    out = os.path.splitext(src)[0] + ".mav"
    open(out, "wb").write(data)
    print(f"wrote {out} ({len(data)} bytes)")
    if "--upload" in sys.argv:
        url = os.environ.get("GW_AVATAR_URL")
        if not url:
            sys.exit("set GW_AVATAR_URL to upload")
        req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/octet-stream"})
        print(urllib.request.urlopen(req, timeout=30).read().decode())

main()
