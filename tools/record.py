#!/usr/bin/env python3
"""Drive the Relay demo and capture the glasses framebuffer.

Writes raw RGBA frames plus markers.json into /tmp/relay-capture.
The compositor (tools/video.py) turns them into the submission video.
"""
import json
import os
import re
import subprocess
import threading
import time
import urllib.request

SIM = "http://127.0.0.1:9898"
APP = "http://127.0.0.1:5200/?fresh=1"
OUT = "/tmp/relay-capture"
FPS = 10.0

markers = []
frames = []
stop = threading.Event()


def get_json(path):
    with urllib.request.urlopen(f"{SIM}{path}", timeout=5) as res:
        return json.loads(res.read().decode())


def post(action):
    req = urllib.request.Request(
        f"{SIM}/api/input",
        data=json.dumps({"action": action}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.loads(res.read().decode())


def wait_ready(timeout=40):
    deadline = time.time() + timeout
    last = -1
    while time.time() < deadline:
        try:
            suffix = f"?since_id={last}" if last >= 0 else ""
            data = get_json(f"/api/console{suffix}")
            for entry in data.get("entries", []):
                last = max(last, entry["id"])
                if "RELAY READY" in entry["message"]:
                    return
        except Exception:
            pass
        time.sleep(0.25)
    raise RuntimeError("app did not become ready")


def capture(t0):
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(".png"):
            os.remove(os.path.join(OUT, f))
    i = 0
    while not stop.is_set():
        try:
            with urllib.request.urlopen(f"{SIM}/api/screenshot/glasses", timeout=5) as res:
                raw = res.read()
            with open(os.path.join(OUT, f"f{i:05d}.png"), "wb") as fh:
                fh.write(raw)
            frames.append(round(time.monotonic() - t0, 3))
        except Exception:
            pass
        i += 1
        target = t0 + i / FPS
        sleep = target - time.monotonic()
        if sleep > 0:
            time.sleep(sleep)
    return t0


def poll_console(t0):
    last = -1
    patterns = [
        (r"RELAY OPEN (.+)$", "open"),
        (r"RELAY LISTEN", "listen"),
        (r"RELAY DRAFT", "draft"),
        (r"RELAY SENT (.+)$", "sent"),
        (r"RELAY BRIEF", "brief"),
        (r"RELAY DIGEST", "digest"),
        (r"RELAY PAIR (\d{6})", "pair"),
        (r"RELAY HEARD (.+)$", "heard"),
    ]
    while not stop.is_set():
        try:
            suffix = f"?since_id={last}" if last >= 0 else ""
            data = get_json(f"/api/console{suffix}")
            for entry in data.get("entries", []):
                last = max(last, entry["id"])
                for pattern, name in patterns:
                    m = re.search(pattern, entry["message"])
                    if m:
                        markers.append(
                            {
                                "name": name,
                                "t": round(time.monotonic() - t0, 3),
                                "message": entry["message"][:160],
                                "match": m.group(1) if m.groups() else None,
                            }
                        )
        except Exception:
            pass
        time.sleep(0.12)


def main():
    print("· restarting simulator fresh")
    subprocess.run(["bash", "tools/sim.sh", "restart", APP], check=True)
    wait_ready()
    time.sleep(1.0)

    print("· recording")
    t0 = time.monotonic()
    capture_thread = threading.Thread(target=capture, args=(t0,), daemon=True)
    console_thread = threading.Thread(target=poll_console, args=(t0,), daemon=True)
    capture_thread.start()
    console_thread.start()

    actions = [
        (6.0, "click"),
        (11.0, "long_press"),
        (13.5, "long_press_release"),
        (20.0, "click"),
        (25.5, "context_menu"),
        (26.3, "click"),
        (31.0, "double_click"),
        (33.0, "context_menu"),
        (33.7, "down"),
        (34.2, "click"),
        (39.0, "double_click"),
    ]
    for at, action in actions:
        delay = t0 + at - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        try:
            post(action)
            print(f"  {at:5.1f}s  {action}")
        except Exception as exc:
            print(f"  {at:5.1f}s  {action} failed: {exc}")

    delay = t0 + 42.0 - time.monotonic()
    if delay > 0:
        time.sleep(delay)
    stop.set()
    time.sleep(0.5)

    meta = {
        "fps": FPS,
        "duration": round(max(frames) if frames else 0, 3),
        "frame_times": frames,
        "markers": markers,
    }
    with open(os.path.join(OUT, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    print(f"· captured {len(frames)} frames, {len(markers)} markers -> {OUT}")


if __name__ == "__main__":
    main()
