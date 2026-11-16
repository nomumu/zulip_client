#!/usr/bin/env python3
"""Zulip の 1 チャンネル分のメッセージを取得し、静的サイト用の JSON に書き出す。

- 既定では未ログイン（web-public 閲覧）で取得する。秘密情報は不要。
- 環境変数 ZULIP_EMAIL / ZULIP_API_KEY があれば、公式 API (/api/v1) を
  Basic 認証で使う（ボットアカウントを推奨）。
- 毎回チャンネル全体を取り直すので、Zulip 側の編集・削除・トピック移動も
  次回の実行で反映される。

標準ライブラリのみで動作する。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
USER_AGENT = "rosjp-zulip-portal/0.1"
BATCH = 1000
MAX_MESSAGES = 50000

# 相対 URL（/user_uploads/... や /static/... など）を絶対 URL に直す対象属性
REL_ATTR_RE = re.compile(r'\b(src|href|data-original-src)="/(?!/)')


def load_config(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def make_request(realm: str, narrow: list, anchor, include_anchor: bool) -> dict:
    email = os.environ.get("ZULIP_EMAIL", "").strip()
    api_key = os.environ.get("ZULIP_API_KEY", "").strip()
    authed = bool(email and api_key)

    params = {
        "narrow": json.dumps(narrow),
        "anchor": str(anchor),
        "num_before": str(BATCH),
        "num_after": "0",
        "include_anchor": "true" if include_anchor else "false",
        "apply_markdown": "true",
        "allow_empty_topic_name": "true",
    }
    base = "/api/v1/messages" if authed else "/json/messages"
    url = f"{realm}{base}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    if authed:
        token = base64.b64encode(f"{email}:{api_key}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")

    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            if e.code == 429 and attempt < 3:
                wait = int(e.headers.get("Retry-After", "10"))
                time.sleep(min(wait, 60))
                continue
            raise SystemExit(f"Zulip API error {e.code}: {body}")
        except urllib.error.URLError as e:
            if attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            raise SystemExit(f"network error: {e}")
    raise SystemExit("retry limit exceeded")


def fetch_all(realm: str, channel_id: int) -> list[dict]:
    authed = bool(os.environ.get("ZULIP_EMAIL") and os.environ.get("ZULIP_API_KEY"))
    narrow = [{"operator": "channel", "operand": channel_id}]
    if not authed:
        narrow.insert(0, {"operator": "channels", "operand": "web-public"})

    messages: list[dict] = []
    anchor, include_anchor = "newest", True
    while True:
        data = make_request(realm, narrow, anchor, include_anchor)
        if data.get("result") != "success":
            raise SystemExit(f"Zulip API error: {data.get('msg')}")
        batch = data.get("messages", [])
        messages = batch + messages
        if data.get("found_oldest") or not batch or len(messages) >= MAX_MESSAGES:
            break
        anchor, include_anchor = batch[0]["id"], False
        time.sleep(1)
    # 念のため重複除去・昇順
    uniq = {m["id"]: m for m in messages}
    return [uniq[k] for k in sorted(uniq)]


def absolutize(html: str, realm: str) -> str:
    html = REL_ATTR_RE.sub(lambda m: f'{m.group(1)}="{realm}/', html)
    # 古い形式の Zulip 内リンク（href="#narrow/..."）も絶対 URL にする
    return html.replace('href="#narrow/', f'href="{realm}/#narrow/')


def avatar_url(url: str | None, realm: str) -> str | None:
    if not url:
        return None
    if url.startswith("/"):
        return realm + url
    return url


def summarize_reactions(reactions: list[dict]) -> list[dict]:
    grouped: "OrderedDict[tuple, int]" = OrderedDict()
    for r in reactions:
        key = (r.get("reaction_type"), r.get("emoji_code"), r.get("emoji_name"))
        grouped[key] = grouped.get(key, 0) + 1
    return [
        {"type": t, "code": c, "name": n, "count": cnt}
        for (t, c, n), cnt in grouped.items()
    ]


def is_system_message(m: dict, realm_str: str) -> bool:
    """Notification Bot などの Zulip システムボットによる自動投稿か。

    システムボットは組織をまたいだ特別なアカウントなので、送信者の所属組織
    （sender_realm_str）がこの組織と異なる。
    """
    sender_realm = m.get("sender_realm_str")
    if sender_realm and sender_realm != realm_str:
        return True
    return m.get("sender_email") == "notification-bot@zulip.com"


def build_output(raw: list[dict], config: dict) -> dict:
    realm = config["realm"].rstrip("/")
    realm_str = urllib.parse.urlparse(realm).hostname.split(".")[0]
    users: dict[str, dict] = {}
    topics: dict[str, dict] = {}
    messages = []
    for m in raw:
        sid = str(m["sender_id"])
        system = is_system_message(m, realm_str)
        users[sid] = {
            "name": m.get("sender_full_name", ""),
            "avatar": avatar_url(m.get("avatar_url"), realm),
        }
        topic = m.get("subject", "")
        t = topics.setdefault(topic, {
            "name": topic, "count": 0,
            "last_id": 0, "last_ts": 0,          # 人の投稿のみで計算（並び順・未読に使う）
            "last_any_id": 0,                    # システム投稿も含む最終 ID（Zulip へのリンク用）
        })
        t["last_any_id"] = m["id"]
        if not system:
            t["count"] += 1
            t["last_id"] = m["id"]
            t["last_ts"] = m["timestamp"]
        msg = {
            "id": m["id"],
            "ts": m["timestamp"],
            "topic": topic,
            "sender": sid,
            "html": absolutize(m.get("content", ""), realm),
            "reactions": summarize_reactions(m.get("reactions", [])),
            "edited": bool(m.get("last_edit_timestamp")),
        }
        if system:
            msg["sys"] = True
        messages.append(msg)
    # システム投稿しかないトピックは、システム投稿の時刻で並べる
    for m in messages:
        t = topics[m["topic"]]
        if t["count"] == 0 and m["id"] == t["last_any_id"]:
            t["last_id"] = m["id"]
            t["last_ts"] = m["ts"]
    return {
        "generated_at": int(time.time()),
        "realm": realm,
        "channel": config["channel"],
        "users": users,
        "topics": sorted(topics.values(), key=lambda t: t["last_id"], reverse=True),
        "messages": messages,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default=str(ROOT / "site" / "config.json"))
    ap.add_argument("--out", default=str(ROOT / "site" / "data" / "channel.json"))
    args = ap.parse_args()

    config = load_config(Path(args.config))
    realm = config["realm"].rstrip("/")
    raw = fetch_all(realm, int(config["channel"]["id"]))
    out = build_output(raw, config)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(out_path)
    mode = "api-key" if os.environ.get("ZULIP_API_KEY") else "web-public"
    print(f"[{mode}] {len(out['messages'])} messages, {len(out['topics'])} topics -> {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
