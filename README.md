# ROS Japan Zulip ビューア（実験版）

[Open Robotics の Zulip](https://openrobotics.zulipchat.com/) にある **Japan チャンネル**を、
Slack に近い見た目で読むための静的サイトです。GitHub Pages で公開することを想定しています。

- **ログイン不要・読むだけ。** 書き込みは「Zulip で書き込む」ボタンで Zulip 本体の該当トピックを開きます。
- 参加ガイドの運用に合わせ、固定トピックを Slack の「チャンネル」のように左に並べます。
  `# はじめに`（[説明]）／`# 一般`（一般チャット）／`# 質問`／`# 告知`／`# 求人`
- 運営が切り出したトピックは「話題（スレッド）」に新しい順で並びます（`[Dev-kaigi]` などの接頭辞はラベル表示、✔ は解決済み）。
- 前回見たところ以降の新着を、ブラウザごとに記録して太字とバッジで表示します（端末をまたいだ同期はしません）。
- 全文検索（本文・トピック名・投稿者）ができます。

## 仕組み

```
GitHub Actions（毎時）
  └─ scripts/fetch_zulip.py が Japan チャンネルを全件取得 → site/data/channel.json
  └─ site/ を GitHub Pages にデプロイ
ブラウザ
  └─ site/index.html + app.js が channel.json を読んで表示
```

- 既定では、Zulip の未ログイン閲覧（web-public）と同じ経路で取得するので、**秘密情報は不要**です。
  - この経路（`/json/messages`）は Zulip の Web 画面が内部で使っているもので、公式に公開されている API ではありません。
    使えなくなった場合は、ボットを作ってリポジトリの Secrets に `ZULIP_EMAIL` / `ZULIP_API_KEY` を登録すると、
    公式 API（`/api/v1`）に切り替わります。
- 毎回全件を取り直すので、Zulip 側での編集・削除・トピック移動も次回の更新で反映されます。
- ブラウザから Zulip には問い合わせません（Zulip の画像やアバターの読み込みを除く）。

## 手元で試す

```bash
python3 scripts/fetch_zulip.py           # site/data/channel.json を生成
python3 -m http.server -d site 8000      # http://localhost:8000/ を開く
```

Python 3.9 以上、標準ライブラリのみで動きます。

## GitHub Pages で公開する

1. このディレクトリを GitHub リポジトリに push する。
2. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする。
3. **Actions** タブで「Update and deploy viewer」を手動実行（Run workflow）する。以降は毎時自動で更新されます。

### private リポジトリで試すときの注意

- **GitHub Free のアカウントでは、private リポジトリから Pages を公開できません。** Pro / Team 以上が必要です。
- Pro でも、**公開されたサイト自体は誰でも見られます**（閲覧者を絞れるのは Enterprise Cloud のみ）。
  実験中であることを示すため、ページには検索エンジン除け（`noindex`）を入れています。
- private リポジトリの Actions は無料枠（Free 2,000 分 / Pro 3,000 分 / 月）を消費します。
  毎時実行で月 約 720 分です。間隔は `.github/workflows/pages.yml` の `cron` で変えられます。
- Pages を使わずに試すだけなら、上の「手元で試す」で十分です。

## 設定

`site/config.json` で、表示名、Zulip のサーバー、チャンネル、固定トピックとラベルを変えられます。
固定トピックはトピック名の**完全一致**で判定します（`"topic": ""` は一般チャット）。
Zulip 側でトピック名を変えたときは、ここも合わせて直してください。

## ファイル構成

| パス | 内容 |
|---|---|
| `scripts/fetch_zulip.py` | Zulip から取得して JSON を書き出す |
| `site/index.html`, `site/style.css`, `site/app.js` | ビューア本体（ビルド不要） |
| `site/config.json` | 表示とチャンネルの設定 |
| `site/vendor/purify.min.js` | HTML の無害化に使う DOMPurify 3.1.6（Apache-2.0 / MPL-2.0） |
| `.github/workflows/pages.yml` | 定期取得と Pages へのデプロイ |
