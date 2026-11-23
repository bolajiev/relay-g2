#!/usr/bin/env python3
"""Fetch the simulator framebuffer and render a viewable preview.

The simulator returns RGBA where every lit pixel is (0,255,0,alpha): colour is
constant, brightness lives in alpha. Compositing over black is the only way to
see what the wearer sees in a normal image viewer.

Usage: tools/shot.py out.png [--scale 2] [--glow]
"""
import io
import sys
import urllib.request
from PIL import Image, ImageFilter

def main() -> int:
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/relay-shot.png"
    scale = 2
    glow = "--glow" in sys.argv
    if "--scale" in sys.argv:
        scale = int(sys.argv[sys.argv.index("--scale") + 1])
    port = 9898
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])

    raw = urllib.request.urlopen(f"http://127.0.0.1:{port}/api/screenshot/glasses", timeout=10).read()
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    lit = sum(1 for px in im.getdata() if px[3] > 0)

    bg = Image.new("RGBA", im.size, (0, 0, 0, 255))
    bg.alpha_composite(im)
    render = bg.convert("RGB")

    if glow:
        halo = render.filter(ImageFilter.GaussianBlur(3))
        render = Image.blend(render, halo, 0.55).point(lambda v: min(255, int(v * 1.35)))

    if scale != 1:
        render = render.resize((render.width * scale, render.height * scale), Image.NEAREST)

    render.save(out)
    print(f"{out} {render.width}x{render.height} lit_pixels={lit} scale={scale}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
