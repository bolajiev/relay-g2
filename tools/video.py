#!/usr/bin/env python3
"""Composite the captured framebuffer into the submission video.

Input:  /tmp/relay-capture/f*.png + meta.json (tools/record.py)
Output: docs/relay-demo.mp4 and docs/relay-demo-poster.png
"""
import json
import os
import subprocess
from PIL import Image, ImageDraw, ImageFilter, ImageFont

CAP = "/tmp/relay-capture"
WORK = "/tmp/relay-video"
OUT = "docs/relay-demo.mp4"
POSTER = "docs/relay-demo-poster.png"

W, H = 1920, 1080
DISP_W, DISP_H = 1152, 576
DISP_X = (W - DISP_W) // 2
DISP_Y = 150
FPS = 10

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_ITAL = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Oblique.ttf"

INK = (216, 255, 226)
DIM = (126, 157, 135)
FAINT = (65, 87, 72)
GREEN = (103, 255, 139)

META = json.load(open(os.path.join(CAP, "meta.json")))
TIMES = META["frame_times"]
MARKERS = META["markers"]


def marker(name, after=-1.0, default=0.0):
    values = [m["t"] for m in MARKERS if m["name"] == name and m["t"] > after]
    return min(values) if values else default


OPEN = marker("open", 0, 6.5)
LISTEN = marker("listen", OPEN, 11.0)
DRAFT = marker("draft", LISTEN, 13.5)
SENT = marker("sent", DRAFT, 20.0)
DIGEST = marker("digest", SENT, 26.0)
MARKET = marker("market", DIGEST, 35.0)
MARKET_LISTEN = marker("market-listen", MARKET, 39.0)
MARKET_CONFIRM = marker("market-confirm", MARKET_LISTEN, 41.5)
DERISK = marker("derisk", MARKET_CONFIRM, 45.2)
PAIR = marker("pair", DERISK, 52.0)
BRIEFS = sorted(m["t"] for m in MARKERS if m["name"] == "brief")
BRIEF2 = next((t for t in BRIEFS if t > SENT), 22.0)
BRIEF3 = next((t for t in BRIEFS if t > DIGEST), 31.0)
BRIEF4 = next((t for t in BRIEFS if t > DERISK), 49.2)
BRIEF5 = next((t for t in BRIEFS if t > PAIR), 56.4)
CAPTURE_END = META["duration"]
# Capture is not guaranteed to hit the nominal 10 fps (screenshot latency).
# Use the observed rate so frame index and marker timestamps stay aligned.
OUT_FPS = len(TIMES) / CAPTURE_END if CAPTURE_END else FPS
END_EXTRA = 8.0
SAFETY_START = CAPTURE_END
SAFETY_END = CAPTURE_END + 4.0
TOTAL = SAFETY_END + 4.0

print(
    f"timeline open={OPEN} listen={LISTEN} draft={DRAFT} sent={SENT} "
    f"digest={DIGEST} market={MARKET} market-listen={MARKET_LISTEN} market-confirm={MARKET_CONFIRM} derisk={DERISK} pair={PAIR} briefs={BRIEFS}"
)


def font(path, size):
    return ImageFont.truetype(path, size)


F = {
    "brand": font(FONT_BOLD, 28),
    "brand_sub": font(FONT_REG, 16),
    "eyebrow": font(FONT_BOLD, 18),
    "headline": font(FONT_BOLD, 44),
    "quote": font(FONT_ITAL, 26),
    "label": font(FONT_REG, 15),
    "title": font(FONT_BOLD, 150),
    "title_sub": font(FONT_REG, 46),
    "title_small": font(FONT_REG, 24),
    "end": font(FONT_BOLD, 76),
    "end_sub": font(FONT_REG, 32),
    "end_small": font(FONT_REG, 20),
}


def spaced(draw, text, x, y, f, fill, gap=8):
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + gap


def background():
    bg = Image.new("RGB", (W, H), (4, 7, 5))
    d = ImageDraw.Draw(bg)
    for y in range(H):
        k = y / H
        d.line([(0, y), (W, y)], fill=(int(5 + 4 * (1 - k)), int(9 + 8 * (1 - k)), int(6 + 5 * (1 - k))))
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse((260, 90, 1660, 800), fill=(18, 92, 44, 55))
    glow = glow.filter(ImageFilter.GaussianBlur(130))
    bg = Image.alpha_composite(bg.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(bg)
    d.line([(110, 96), (1810, 96)], fill=(17, 31, 22), width=1)
    return bg


BG = background()


def wrap(draw, text, f, max_w):
    words = text.split()
    lines, line = [], ""
    for word in words:
        test = (line + " " + word).strip()
        if draw.textlength(test, font=f) <= max_w:
            line = test
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def caption_for(t):
    if t < 3.5:
        return None
    if t < OPEN:
        return ("01 · READ", "Five people are waiting. Not fifty messages.", None)
    if t < LISTEN:
        return ("02 · READ", "The ask, extracted. Not the chat log.", None)
    if t < DRAFT:
        return ("03 · SPEAK", "Hold the ring. Say it once, badly.", "\"yeah tell her I'll send it by 4:30\"")
    if t < SENT:
        return ("04 · WRITE", "AI drafts it in your voice. You approve.", None)
    if t < BRIEF2:
        return ("05 · SEND", "One tap. Sent. Four left.", None)
    if t < DIGEST:
        return ("06 · BACK", "The phone never left your pocket.", None)
    if t < BRIEF3:
        return ("07 · DIGEST", "Channels never interrupt. They wait here.", None)
    if t < MARKET:
        return ("08 · RISK", "Now the other kind of open loop.", None)
    if t < MARKET_LISTEN:
        return ("09 · MARKETS", "A Telegram signal. A live position. PAPER.", None)
    if t < MARKET_CONFIRM:
        return ("10 · SPEAK", "Say \"de-risk 25\". Release to confirm.", None)
    if t < DERISK:
        return ("11 · CONFIRM", "One tap. No real funds. No API keys.", None)
    if t < BRIEF4:
        return ("12 · DE-RISK", "Risk cut. Liquidation moved away.", None)
    if t < PAIR:
        return ("13 · BACK", "Back to people.", None)
    if t < BRIEF5:
        return ("14 · PAIR", "Connect Telegram with a 6-digit code.", "No API keys on the glasses.")
    return ("15 · DONE", "Read. Speak. Confirm.", None)


def display_frame(raw_path):
    raw = Image.open(raw_path).convert("RGBA")
    black = Image.new("RGBA", raw.size, (0, 0, 0, 255))
    black.alpha_composite(raw)
    return black.convert("RGB").resize((DISP_W, DISP_H), Image.NEAREST)


def draw_title(draw):
    title = "RELAY"
    tw = sum(draw.textlength(ch, font=F["title"]) + 18 for ch in title) - 18
    spaced(draw, title, (W - tw) / 2, 300, F["title"], GREEN, 18)
    sub = "Reply debt, cleared."
    sw = draw.textlength(sub, font=F["title_sub"])
    draw.text(((W - sw) / 2, 485), sub, font=F["title_sub"], fill=INK)
    small = "People waiting. Positions at risk."
    mw = draw.textlength(small, font=F["title_small"])
    draw.text(((W - mw) / 2, 555), small, font=F["title_small"], fill=GREEN)
    small2 = "Read at a glance. Speak. Confirm."
    mw2 = draw.textlength(small2, font=F["title_small"])
    draw.text(((W - mw2) / 2, 600), small2, font=F["title_small"], fill=DIM)
    tiny = "DEMO  ·  FICTIONAL INBOX  ·  EVEN G2"
    tw2 = draw.textlength(tiny, font=F["label"])
    draw.text(((W - tw2) / 2, 980), tiny, font=F["label"], fill=FAINT)


def draw_end(draw):
    title = "Read. Speak. Confirm."
    tw = draw.textlength(title, font=F["end"])
    draw.text(((W - tw) / 2, 380), title, font=F["end"], fill=INK)
    sub = "Relay — people and positions."
    sw = draw.textlength(sub, font=F["end_sub"])
    draw.text(((W - sw) / 2, 505), sub, font=F["end_sub"], fill=GREEN)
    small = "Built for the Even Realities Heads Up hackathon · 2026"
    mw = draw.textlength(small, font=F["end_small"])
    draw.text(((W - mw) / 2, 570), small, font=F["end_small"], fill=DIM)
    tiny = "DEMO  ·  FICTIONAL INBOX  ·  EVEN G2"
    tw2 = draw.textlength(tiny, font=F["label"])
    draw.text(((W - tw2) / 2, 980), tiny, font=F["label"], fill=FAINT)


def compose(t, raw_path=None):
    img = BG.copy()
    d = ImageDraw.Draw(img)

    if t < 3.5:
        draw_title(d)
        return img
    if t >= SAFETY_END:
        draw_end(d)
        d.line([(110, 1008), (1810, 1008)], fill=(20, 38, 27), width=1)
        return img

    spaced(d, "RELAY", 110, 44, F["brand"], GREEN, 5)
    d.text((110, 80), "Telegram, at a glance", font=F["brand_sub"], fill=DIM)
    right = "EVEN G2  ·  576 × 288"
    rw = d.textlength(right, font=F["label"])
    d.text((W - 110 - rw, 52), right, font=F["label"], fill=FAINT)

    if SAFETY_START <= t < SAFETY_END:
        first = t < SAFETY_START + 2
        raw = "docs/detail-check.png" if first else "docs/draft-check.png"
        disp = display_frame(raw)
        img.paste(disp, (DISP_X, DISP_Y))
        d.rounded_rectangle(
            (DISP_X - 4, DISP_Y - 4, DISP_X + DISP_W + 4, DISP_Y + DISP_H + 4),
            radius=18,
            outline=(34, 66, 44),
            width=2,
        )
        eyebrow = "SAFETY · CHECK" if first else "SAFETY · REVIEW"
        headline = "Sensitive ask? Never a default yes." if first else "Tap to review. Then send."
        d.text((110, 790), eyebrow, font=F["eyebrow"], fill=GREEN)
        d.text((110, 826), headline, font=F["headline"], fill=INK)
        d.rectangle((110, 1022, 1810, 1025), fill=(22, 36, 27))
        pct = max(0.0, min(1.0, t / TOTAL))
        d.rectangle((110, 1022, 110 + int(1700 * pct), 1025), fill=(46, 128, 67))
        return img


    if raw_path and os.path.exists(raw_path):
        disp = display_frame(raw_path)
        img.paste(disp, (DISP_X, DISP_Y))
        d.rounded_rectangle(
            (DISP_X - 4, DISP_Y - 4, DISP_X + DISP_W + 4, DISP_Y + DISP_H + 4),
            radius=18,
            outline=(34, 66, 44),
            width=2,
        )

    cap = caption_for(t)
    if cap:
        eyebrow, headline, quote = cap
        d.text((110, 790), eyebrow, font=F["eyebrow"], fill=GREEN)
        lines = wrap(d, headline, F["headline"], W - 220)
        y = 826
        for line in lines:
            d.text((110, y), line, font=F["headline"], fill=INK)
            y += 56
        if quote:
            d.text((110, y + 8), quote, font=F["quote"], fill=(143, 174, 150))

    # progress
    d.rectangle((110, 1022, 1810, 1025), fill=(22, 36, 27))
    pct = max(0.0, min(1.0, t / TOTAL))
    d.rectangle((110, 1022, 110 + int(1700 * pct), 1025), fill=(46, 128, 67))
    return img


def main():
    os.makedirs(WORK, exist_ok=True)
    os.makedirs("docs", exist_ok=True)
    for f in os.listdir(WORK):
        if f.endswith(".png"):
            os.remove(os.path.join(WORK, f))

    frame_files = sorted(f for f in os.listdir(CAP) if f.startswith("f") and f.endswith(".png"))
    count = 0
    poster_saved = False
    for i, name in enumerate(frame_files):
        t = TIMES[i] if i < len(TIMES) else i / FPS
        image = compose(t, os.path.join(CAP, name))
        if not poster_saved and t >= DRAFT + 1.0:
            image.save(POSTER)
            poster_saved = True
        image.save(os.path.join(WORK, f"f{count:05d}.png"))
        count += 1

    extra = int(END_EXTRA * OUT_FPS)
    for j in range(extra):
        t = CAPTURE_END + j / OUT_FPS
        compose(t).save(os.path.join(WORK, f"f{count:05d}.png"))
        count += 1

    print(f"· composited {count} frames at {OUT_FPS:.2f} fps ({count / OUT_FPS:.1f}s)")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-framerate",
            f"{OUT_FPS:.4f}",
            "-i",
            os.path.join(WORK, "f%05d.png"),
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            OUT,
        ],
        check=True,
    )
    print(f"· wrote {OUT} ({os.path.getsize(OUT) / 1_000_000:.1f} MB)")
    print(f"· poster {POSTER}")


if __name__ == "__main__":
    main()
