"""Away agent (S02E05): HTTPS channel for the course, ntfy pings to the owner's phone.

Free acts run at once. Gated acts are held until the owner publishes
"approve <id> <passphrase>" to a private ntfy reply topic. Policy is enforced here in
code; message text can never change it.

Env: SIGNING_KEY, NTFY_TOPIC, NTFY_REPLY_TOPIC, APPROVAL_PASSPHRASE, PORT, STATE_DIR
"""

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("away-agent")

SIGNING_KEY = os.environ.get("SIGNING_KEY", "")
NTFY = os.environ["NTFY_TOPIC"]
NTFY_REPLY = os.environ["NTFY_REPLY_TOPIC"]
PASSPHRASE = os.environ["APPROVAL_PASSPHRASE"]
PORT = int(os.getenv("PORT", "8080"))
HOLD_SECONDS = 55 * 60  # the course allows 60 minutes

POLICY = {
    "post_status": "free",
    "ack_alert": "free",
    "archive_report": "free",
    "purge_cache": "free",
    "release_hold": "gated",
    "rotate_key": "gated",
}
ACTION_TEXT = {
    "post_status": "posted the status line to the team channel",
    "ack_alert": "acknowledged the open alert",
    "archive_report": "moved the finished report into the archive",
    "purge_cache": "cleared the build cache",
    "release_hold": "released the held deploy to production",
    "rotate_key": "rotated the shared API key",
}
ACT_RE = re.compile(r"\b(" + "|".join(POLICY) + r")\b")

held: dict[str, dict] = {}
seen: set[str] = set()
lock = threading.Lock()


def acts_in(text: str) -> list[str]:
    out = []
    for a in ACT_RE.findall(text):
        if a not in out:
            out.append(a)
    return out


def ping(title: str, body: str, priority: str = "default", topic: str = NTFY):
    try:
        httpx.post(
            f"https://ntfy.sh/{topic}",
            content=body.encode(),
            headers={"Title": title, "Priority": priority},
            timeout=15,
        )
    except Exception:
        log.exception("ntfy ping failed")


def reply(url: str, text: str):
    try:
        r = httpx.post(url, json={"text": text}, timeout=20)
        log.info("reply -> %s %s", r.status_code, text[:120].replace("\n", " | "))
    except Exception:
        log.exception("reply failed")


def perform(act: str) -> str:
    # The acts are simulated here: the course only checks that policy was respected.
    log.info("PERFORM %s", act)
    return f"DONE: {act}"


def process(msg: dict):
    text = f"{msg.get('subject', '')}\n{msg.get('text', '')}"
    url = msg["replyUrl"]
    acts = acts_in(text)
    if not acts:
        reply(url, "No known act in this message, so I did nothing.")
        ping("Away agent: unclear message", text[:200])
        return
    lines = []
    for act in acts:
        if POLICY[act] == "free":
            lines.append(perform(act))
        else:
            hid = secrets.token_hex(2)
            with lock:
                held[hid] = {"act": act, "url": url, "t": time.time()}
            ping(
                f"Approve {act}?",
                f"{msg.get('from')} asks: {text[:200]}\n"
                f"Reply on topic {NTFY_REPLY}: approve {hid} <passphrase> <course code>  (or: deny {hid})",
                "high",
            )
            lines.append(f"HOLD: {act}")
    reply(url, "\n".join(lines))


def handle_command(line: str):
    parts = line.strip().split(None, 2)
    if len(parts) < 2 or parts[0].lower() not in ("approve", "deny"):
        return
    cmd, hid = parts[0].lower(), parts[1]
    with lock:
        item = held.get(hid)
    if not item:
        ping("Away agent", f"No held request {hid}.", topic=NTFY)
        return
    if time.time() - item["t"] > HOLD_SECONDS:
        with lock:
            held.pop(hid, None)
        ping("Away agent", f"Request {hid} expired.")
        return
    if cmd == "deny":
        with lock:
            held.pop(hid, None)
        reply(item["url"], f"DENIED: {item['act']} was refused by my owner. Nothing was done.")
        ping("Away agent", f"Denied {item['act']} ({hid}).")
        return
    rest = parts[2].split() if len(parts) > 2 else []
    given = rest[0] if rest else ""
    code = rest[1] if len(rest) > 1 else ""
    if not hmac.compare_digest(given.encode(), PASSPHRASE.encode()):
        ping("Away agent", f"Wrong passphrase for {hid}. Still held.", "high")
        return
    if not code:
        ping("Away agent", f"Missing course code for {hid}. Still held.", "high")
        return
    with lock:
        held.pop(hid, None)
    out = perform(item["act"]) + f" CODE: {code}"
    reply(item["url"], out)
    ping("Away agent", f"Approved and done: {item['act']} ({hid}).")


def seed():
    # SEED_HELD="id|act|replyUrl|doneActs": re-create a request held before a restart
    v = os.getenv("SEED_HELD", "")
    if not v:
        return
    hid, act, url, done = v.split("|")
    held[hid] = {"act": act, "url": url, "t": time.time()}
    lines = [f"DONE: {a}" for a in done.split(",") if a] + [f"HOLD: {act}"]
    reply(url, "\n".join(lines))
    ping(f"Approve {act}?", f"Reply on topic {NTFY_REPLY}: approve {hid} <passphrase> <course code>  (or: deny {hid})", "high")


def watch_replies():
    while True:
        try:
            with httpx.stream(
                "GET", f"https://ntfy.sh/{NTFY_REPLY}/json", timeout=httpx.Timeout(30, read=None)
            ) as r:
                for line in r.iter_lines():
                    if not line:
                        continue
                    ev = json.loads(line)
                    if ev.get("event") == "message":
                        handle_command(ev.get("message", ""))
        except Exception:
            log.exception("reply watcher dropped, retrying")
            time.sleep(5)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body=b"ok"):
        self.send_response(code)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200, b"away agent up")

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length", 0)))
        ts = self.headers.get("x-course-timestamp", "")
        sig = self.headers.get("x-course-signature", "")
        want = "sha256=" + hmac.new(
            SIGNING_KEY.encode(), ts.encode() + b"." + raw, hashlib.sha256
        ).hexdigest()
        if not SIGNING_KEY or not hmac.compare_digest(sig, want):
            log.warning("rejected POST: bad signature")
            return self._send(401, b"bad signature")
        try:
            msg = json.loads(raw)
        except Exception:
            return self._send(400, b"bad json")
        # the course may nest the message under "post"
        msg = msg.get("post", msg)
        key = hashlib.sha256(ts.encode() + raw).hexdigest()
        with lock:
            if key in seen:
                return self._send(200)
            seen.add(key)
        log.info("message from %s: %s | text: %s", msg.get("from"), str(msg.get("subject"))[:80], str(msg.get("text"))[:600].replace("\n", " / "))
        threading.Thread(target=process, args=(msg,), daemon=True).start()
        self._send(200)


if __name__ == "__main__":
    seed()
    threading.Thread(target=watch_replies, daemon=True).start()
    ping("Away agent started", "Listening for the course.")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
