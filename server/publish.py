"""Posting rendered shorts to your own YouTube channel.

Uses your own Google OAuth client (a "Desktop app" client with the YouTube
Data API v3 enabled), set as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in
.env.local. Signing in happens in your browser on Google's own page; the
refresh token it gives back is kept in data/accounts/ on this computer only.
"""
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from shorts.proofread import _setting

from . import store

AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status"
CHANNEL = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true"
SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"
_pending: dict[str, float] = {}  # OAuth "state" values handed out, so a callback can't be forged


class PublishError(RuntimeError):
    pass


def _account_path() -> Path:
    return store.DATA / "accounts" / "youtube.json"


def _client() -> tuple[str, str] | None:
    cid, secret = _setting("GOOGLE_CLIENT_ID"), _setting("GOOGLE_CLIENT_SECRET")
    return (cid, secret) if cid and secret else None


def _post(url: str, data: dict) -> dict:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise PublishError(f"Google said: {e.read().decode(errors='replace')[:300]}") from e


def status() -> dict:
    p = _account_path()
    acc = json.loads(p.read_text()) if p.exists() else None
    return {"configured": _client() is not None, "connected": acc is not None,
            "channel": acc.get("channel") if acc else None}


def connect_url(redirect: str) -> str:
    client = _client()
    if not client:
        raise PublishError("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local first")
    state = secrets.token_urlsafe(24)
    _pending[state] = time.time()
    return AUTH + "?" + urllib.parse.urlencode({
        "client_id": client[0], "redirect_uri": redirect, "response_type": "code", "scope": SCOPES,
        "access_type": "offline", "prompt": "consent", "state": state})


def finish_connect(code: str, state: str, redirect: str) -> dict:
    if time.time() - _pending.pop(state, 0) > 600:
        raise PublishError("this sign-in link expired or wasn't started here; try connecting again")
    cid, secret = _client()
    tok = _post(TOKEN, {"code": code, "client_id": cid, "client_secret": secret,
                        "redirect_uri": redirect, "grant_type": "authorization_code"})
    if "refresh_token" not in tok:
        raise PublishError("Google didn't return a refresh token; remove the app's access in your Google account and connect again")
    channel = None
    try:
        req = urllib.request.Request(CHANNEL, headers={"Authorization": f"Bearer {tok['access_token']}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            items = json.loads(r.read()).get("items") or []
        channel = items[0]["snippet"]["title"] if items else None
    except (urllib.error.URLError, KeyError):
        pass
    p = _account_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"refresh_token": tok["refresh_token"], "channel": channel}))
    p.chmod(0o600)
    return status()


def disconnect() -> dict:
    _account_path().unlink(missing_ok=True)
    return status()


def _access_token() -> str:
    p = _account_path()
    if not p.exists():
        raise PublishError("connect your YouTube channel first")
    cid, secret = _client() or (None, None)
    if not cid:
        raise PublishError("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local first")
    tok = _post(TOKEN, {"refresh_token": json.loads(p.read_text())["refresh_token"], "client_id": cid,
                        "client_secret": secret, "grant_type": "refresh_token"})
    return tok["access_token"]


def upload(video: Path, title: str, description: str, tags: list[str], privacy: str,
           publish_at: float | None = None, on_progress=None) -> dict:
    """Upload one short. With `publish_at` (unix time) it goes up private and
    YouTube makes it public at that time. Returns {"id", "url"}."""
    token = _access_token()
    status_part = {"privacyStatus": "private" if publish_at else privacy, "selfDeclaredMadeForKids": False}
    if publish_at:
        status_part["publishAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(publish_at))
    meta = {"snippet": {"title": title[:100], "description": description[:5000], "tags": tags[:30]},
            "status": status_part}
    size = video.stat().st_size
    req = urllib.request.Request(UPLOAD, data=json.dumps(meta).encode(), method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": str(size)})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            session = r.headers["Location"]
    except urllib.error.HTTPError as e:
        raise PublishError(f"YouTube refused the upload: {e.read().decode(errors='replace')[:300]}") from e
    chunk, sent = 8 * 1024 * 1024, 0
    with video.open("rb") as f:
        while True:
            data = f.read(chunk)
            end = sent + len(data) - 1
            req = urllib.request.Request(session, data=data, method="PUT", headers={
                "Authorization": f"Bearer {token}", "Content-Length": str(len(data)),
                "Content-Range": f"bytes {sent}-{end}/{size}"})
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    out = json.loads(r.read())
                    return {"id": out["id"], "url": f"https://youtube.com/shorts/{out['id']}"}
            except urllib.error.HTTPError as e:
                if e.code != 308:  # 308 = "keep going"
                    raise PublishError(f"YouTube stopped the upload: {e.read().decode(errors='replace')[:300]}") from e
            sent = end + 1
            if on_progress:
                on_progress(sent / size)
