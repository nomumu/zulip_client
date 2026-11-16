/* ROS Japan Zulip ビューア
 * data/channel.json（GitHub Actions が定期生成）を読み、Slack 風に表示する。
 * 書き込みはすべて Zulip 本体へのリンクで行う。
 */
(() => {
  "use strict";

  const SEEN_KEY = "rosjp-zulip:seen";
  const FEED_PAGE = 200;
  const GROUP_GAP_SEC = 5 * 60;

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  };

  const state = {
    config: null,
    data: null,
    users: {},
    topics: new Map(),      // name -> topic meta
    byTopic: new Map(),     // name -> [messages]
    pinnedByTopic: new Map(),
    seen: {},
    feedLimit: FEED_PAGE,
  };

  /* ---------- storage (best effort) ---------- */
  function loadSeen() {
    try {
      const raw = localStorage.getItem(SEEN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function saveSeen() {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(state.seen)); } catch { /* ignore */ }
  }

  /* ---------- Zulip URL helpers ---------- */
  // Zulip の URL ハッシュ形式（% を . に置き換える）
  const encodeHash = (s) =>
    encodeURIComponent(s).replace(/[%().]/g, (c) => ({ "%": ".", "(": ".28", ")": ".29", ".": ".2E" })[c]);
  const decodeHash = (s) => {
    try { return decodeURIComponent(s.replace(/\./g, "%")); } catch { return s; }
  };
  const channelUrl = () => {
    const { realm, channel } = state.config;
    return `${realm}/#narrow/channel/${channel.id}-${encodeHash(channel.name.replace(/ /g, "-"))}`;
  };
  const topicUrl = (topic, withId) =>
    `${channelUrl()}/topic/${encodeHash(topic)}${withId ? `/with/${withId}` : ""}`;
  const messageUrl = (m) => `${channelUrl()}/topic/${encodeHash(m.topic)}/near/${m.id}`;

  /* ---------- portal routes ---------- */
  const routeTopic = (topic, msgId) => `#/t/${encodeURIComponent(topic)}${msgId ? `/${msgId}` : ""}`;
  function parseRoute() {
    const h = location.hash || "";
    let m;
    if ((m = h.match(/^#\/t\/([^/]*)(?:\/(\d+))?$/))) {
      let topic;
      try { topic = decodeURIComponent(m[1]); } catch { topic = m[1]; }
      return { view: "topic", topic, msgId: m[2] ? Number(m[2]) : null };
    }
    if ((m = h.match(/^#\/search\/(.*)$/))) {
      let q;
      try { q = decodeURIComponent(m[1]); } catch { q = m[1]; }
      return { view: "search", q };
    }
    return { view: "feed" };
  }

  /* ---------- topic naming ---------- */
  const RESOLVED_RE = /^✔\s*/;
  const PREFIX_RE = /^\s*\[([^\]]{1,20})\]\s*/;
  function topicParts(name) {
    let rest = name;
    const resolved = RESOLVED_RE.test(rest);
    rest = rest.replace(RESOLVED_RE, "");
    const pm = rest.match(PREFIX_RE);
    const prefix = pm ? pm[1] : null;
    if (pm) rest = rest.slice(pm[0].length);
    return { resolved, prefix, title: rest || name };
  }
  function topicLabel(name) {
    const p = state.pinnedByTopic.get(name);
    if (p) return `# ${p.label}`;
    if (name === "") return "# 一般";
    return name;
  }

  /* ---------- unread (per browser) ---------- */
  function unreadCount(topic) {
    const t = state.topics.get(topic);
    if (!t) return 0;
    const seen = state.seen[topic] || 0;
    if (t.last_id <= seen) return 0;
    const list = state.byTopic.get(topic) || [];
    let n = 0;
    // システム投稿（トピック移動・解決など）は未読に数えない
    for (let i = list.length - 1; i >= 0 && list[i].id > seen; i--) if (!list[i].sys) n++;
    return n;
  }
  const lastAnyId = (t) => Math.max(t.last_id || 0, t.last_any_id || 0);
  function markSeen(topic) {
    const t = state.topics.get(topic);
    if (t && (state.seen[topic] || 0) < lastAnyId(t)) {
      state.seen[topic] = lastAnyId(t);
      saveSeen();
    }
  }
  function markAllSeen() {
    for (const [name, t] of state.topics) state.seen[name] = lastAnyId(t);
    saveSeen();
  }

  /* ---------- formatting ---------- */
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const pad = (n) => String(n).padStart(2, "0");
  const fmtTime = (ts) => { const d = new Date(ts * 1000); return `${d.getHours()}:${pad(d.getMinutes())}`; };
  const dayKey = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  function fmtDay(ts) {
    const d = new Date(ts * 1000);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const that = new Date(d); that.setHours(0, 0, 0, 0);
    const diff = Math.round((today - that) / 86400000);
    if (diff === 0) return "今日";
    if (diff === 1) return "昨日";
    const y = d.getFullYear() !== today.getFullYear() ? `${d.getFullYear()}年` : "";
    return `${y}${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;
  }
  const fmtFull = (ts) => {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad(d.getMinutes())}`;
  };
  function fmtAgo(ts) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 90) return "たった今";
    if (s < 3600) return `${Math.round(s / 60)}分前`;
    if (s < 86400) return `${Math.round(s / 3600)}時間前`;
    return `${Math.round(s / 86400)}日前`;
  }
  const emojiFromCode = (code) => {
    try { return String.fromCodePoint(...code.split("-").map((h) => parseInt(h, 16))); } catch { return null; }
  };

  /* ---------- content rendering ---------- */
  const internalLinkRe = () => new RegExp(
    `^${state.config.realm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/#narrow/(?:channel|stream)/(\\d+)[^/]*/topic/([^/]*)(?:/(?:near|with)/(\\d+))?`
  );

  function renderContent(html) {
    const box = el("div", { class: "content" });
    if (window.DOMPurify) {
      box.innerHTML = window.DOMPurify.sanitize(html, { ADD_ATTR: ["target"], FORBID_TAGS: ["style", "form", "input"] });
    } else {
      // サニタイザが読み込めない場合は安全側に倒してテキストのみ表示
      const tmp = new DOMParser().parseFromString(html, "text/html");
      box.textContent = tmp.body.textContent || "";
      return box;
    }
    const linkRe = internalLinkRe();
    for (const a of box.querySelectorAll("a[href]")) {
      const m = a.getAttribute("href").match(linkRe);
      if (m && Number(m[1]) === state.config.channel.id) {
        a.setAttribute("href", routeTopic(decodeHash(m[2]), m[3] ? Number(m[3]) : null));
        a.removeAttribute("target");
      } else {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    }
    for (const span of box.querySelectorAll("span.emoji")) {
      const cls = [...span.classList].find((c) => /^emoji-[0-9a-f-]+$/.test(c));
      const ch = cls && emojiFromCode(cls.slice(6));
      if (ch) span.textContent = ch;
    }
    for (const t of box.querySelectorAll("time[datetime]")) {
      const d = new Date(t.getAttribute("datetime"));
      if (!isNaN(d)) t.textContent = fmtFull(d.getTime() / 1000);
    }
    for (const img of box.querySelectorAll("img")) {
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
    }
    for (const h of box.querySelectorAll(".spoiler-header")) {
      h.addEventListener("click", () => h.parentElement.classList.toggle("open"));
    }
    return box;
  }

  function renderReactions(list) {
    if (!list || !list.length) return null;
    const wrap = el("div", { class: "reactions" });
    for (const r of list) {
      // カスタム絵文字（realm_emoji）は画像 URL が取得データに無いので名前で表示
      const ch = r.type === "unicode_emoji" && r.code ? emojiFromCode(r.code) : null;
      const face = el("span", { text: ch || `:${r.name}:` });
      wrap.append(el("span", { class: "reaction", title: `:${r.name}:` }, face, el("span", { class: "count", text: String(r.count) })));
    }
    return wrap;
  }

  function avatarNode(user) {
    const name = user?.name || "?";
    if (user?.avatar) {
      const img = el("img", { class: "avatar", src: user.avatar, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
      img.addEventListener("error", () => img.replaceWith(el("div", { class: "avatar", text: name.slice(0, 1) })), { once: true });
      return img;
    }
    return el("div", { class: "avatar", text: name.slice(0, 1) });
  }

  /* ---------- system messages (Notification Bot) ---------- */
  // Zulip のシステム投稿（英語）を日本語の一行に置き換える。{who} {link} {n} を差し込む。
  // 第3要素 true: {link} をリンクにする（移動先）。移動元は名前が変わって
  // 空になっていることが多いので文字だけにする。
  const SYSTEM_PATTERNS = [
    [/^This topic was moved here from .+ by .+\.$/s, "{who} さんがトピックを移動しました（移動元: {link}）", false],
    [/^(\d+|A) messages? (?:was|were) moved here from .+ by .+\.$/s, "{who} さんが {link} から {n}件のメッセージを移動しました", false],
    [/^This topic was moved to .+ by .+\.$/s, "{who} さんがこのトピックを {link} に移動しました", true],
    [/^(\d+|A) messages? (?:was|were) moved from this topic to .+ by .+\.$/s, "{who} さんが {n}件のメッセージを {link} に移動しました", true],
    [/^.+ has marked this topic as resolved\.$/s, "{who} さんがこのトピックを解決済みにしました", false],
    [/^.+ has marked this topic as unresolved\.$/s, "{who} さんがこのトピックを未解決に戻しました", false],
    [/^(?:Web-public |Public |Private )?channel created by .+?\./is, "{who} さんがこのチャンネルを作成しました", false],
  ];

  function renderSystem(m, opts) {
    const content = renderContent(m.html);
    const text = (content.textContent || "").trim().replace(/\s+/g, " ");
    const line = el("div", { class: "sysmsg", id: `m${m.id}`, "data-id": m.id }, el("span", { class: "sys-icon", "aria-hidden": "true", text: "↪" }));
    const body = el("span", { class: "sys-text" });

    let matched = null;
    for (const [re, tpl, linkable] of SYSTEM_PATTERNS) {
      const r = text.match(re);
      if (r) { matched = { tpl, linkable, n: r[1] === "A" ? "1" : r[1] }; break; }
    }
    if (matched) {
      const mention = content.querySelector(".user-mention");
      const who = mention ? mention.textContent.replace(/^@/, "") : "誰か";
      const a = content.querySelector("a");
      let link = null;
      if (a) {
        // 「#Japan > トピック名」→「トピック名」
        let name = a.textContent.replace(/^#[^>]*>\s*/, "").trim();
        if (!name || name === "general chat") name = "一般チャット";
        link = matched.linkable ? a.cloneNode(false) : el("span", { class: "sys-topic" });
        link.textContent = name;
      }
      for (const part of matched.tpl.split(/(\{\w+\})/)) {
        if (part === "{who}") body.append(el("b", { text: who }));
        else if (part === "{link}") body.append(link || "別のトピック");
        else if (part === "{n}") body.append(matched.n || "");
        else if (part) body.append(part);
      }
    } else {
      body.append(text);
    }
    line.append(body);
    if (opts.showTopic) line.append(el("a", { class: "topic-tag", href: routeTopic(m.topic), text: topicLabel(m.topic) }));
    line.append(el("a", { class: "time", href: routeTopic(m.topic, m.id), title: fmtFull(m.ts), text: fmtTime(m.ts) }));
    return line;
  }

  /* messages: 昇順の配列。opts.showTopic: トピックタグを表示（フィード/検索）
     opts.newAfter: {topic: seenId} これより新しいものの前に「新着」線 */
  function renderMessages(messages, opts = {}) {
    const frag = document.createDocumentFragment();
    let prev = null;
    let newShown = false;
    let lastDay = null; // prev はシステム投稿でリセットされるので日付は別に持つ
    for (const m of messages) {
      if (dayKey(m.ts) !== lastDay) {
        frag.append(el("div", { class: "day-divider" }, el("span", { text: fmtDay(m.ts) })));
        lastDay = dayKey(m.ts);
        prev = null;
      }
      if (m.sys) {
        frag.append(renderSystem(m, opts));
        prev = null;
        continue;
      }
      if (opts.newAfter && !newShown) {
        // 記録の無いトピック＝前回訪問以降にできたトピックなので新着扱い
        const seen = opts.newAfter[m.topic] ?? 0;
        if (m.id > seen) {
          frag.append(el("div", { class: "new-divider", text: "ここから新着" }));
          newShown = true;
          prev = null;
        }
      }
      const user = state.users[m.sender];
      const cont = prev && prev.sender === m.sender && prev.topic === m.topic && m.ts - prev.ts < GROUP_GAP_SEC;
      const body = el("div", { class: "body" });
      if (!cont) {
        const head = el("div", { class: "msg-head" },
          el("span", { class: "sender", text: user?.name || "不明なユーザー" }),
          el("a", { class: "time", href: routeTopic(m.topic, m.id), title: fmtFull(m.ts), text: fmtTime(m.ts) }),
        );
        if (opts.showTopic) {
          head.append(el("a", { class: "topic-tag", href: routeTopic(m.topic), text: topicLabel(m.topic) }));
        }
        body.append(head);
      }
      body.append(renderContent(m.html));
      if (m.edited) body.append(el("span", { class: "edited", text: "（編集済み）" }));
      const rx = renderReactions(m.reactions);
      if (rx) body.append(rx);

      const gutter = cont
        ? el("a", { class: "gutter-time time", href: routeTopic(m.topic, m.id), title: fmtFull(m.ts), text: fmtTime(m.ts) })
        : avatarNode(user);
      frag.append(el("article", { class: `msg${cont ? " cont" : ""}`, id: `m${m.id}`, "data-id": m.id }, gutter, body));
      prev = m;
    }
    return frag;
  }

  /* ---------- sidebar ---------- */
  function navItem({ href, hash = "#", label, chip, title, active, unread, resolved }) {
    const a = el("a", {
      class: `nav-item${active ? " active" : ""}${unread ? " unread" : ""}${resolved ? " resolved" : ""}`,
      href, title: title || null,
    }, el("span", { class: "hash", text: hash }));
    const lab = el("span", { class: "label" });
    if (chip) lab.append(el("span", { class: "chip", text: chip }));
    lab.append(label);
    a.append(lab);
    if (unread) a.append(el("span", { class: "badge", text: unread > 99 ? "99+" : String(unread) }));
    a.addEventListener("click", closeNav);
    return a;
  }

  function renderNav(route) {
    const nav = $("nav");
    nav.replaceChildren();

    const top = el("div", { class: "nav-section" });
    const totalUnread = [...state.topics.keys()].reduce((s, t) => s + unreadCount(t), 0);
    top.append(navItem({ href: "#/", hash: "◎", label: "新着（すべての話題）", active: route.view === "feed", unread: totalUnread }));
    nav.append(top);

    const pinned = el("div", { class: "nav-section" }, el("div", { class: "nav-heading", text: "チャンネル" }));
    for (const p of state.config.pinned) {
      pinned.append(navItem({
        href: routeTopic(p.topic), label: p.label, title: p.description,
        active: route.view === "topic" && route.topic === p.topic,
        unread: unreadCount(p.topic),
      }));
    }
    nav.append(pinned);

    // data.topics は最終投稿の新しい順に並んでいる（fetch_zulip.py で整列済み）
    const others = [...state.topics.values()].filter((t) => !state.pinnedByTopic.has(t.name));
    const open = [];
    const resolved = [];
    for (const t of others) (topicParts(t.name).resolved ? resolved : open).push(t);

    const topicItem = (t, showChip) => {
      const p = topicParts(t.name);
      return navItem({
        href: routeTopic(t.name), hash: p.resolved ? "✓" : "↳", label: p.title,
        chip: showChip ? p.prefix : null,
        title: `${t.name}（${t.count}件・最終 ${fmtFull(t.last_ts)}）`,
        active: route.view === "topic" && route.topic === t.name,
        unread: unreadCount(t.name), resolved: p.resolved,
      });
    };

    if (open.length) {
      // [接頭辞] ごとにグループ化。入力が新しい順なので、Map の挿入順＝
      // 各グループの最新トピックが新しい順になり、グループ内も新しい順になる。
      const groups = new Map();
      for (const t of open) {
        const key = topicParts(t.name).prefix || "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
      }
      // 見出しは付けず、同じタグの行を隣り合わせに並べる（各行にタグを表示）
      const sec = el("div", { class: "nav-section" }, el("div", { class: "nav-heading", text: "話題（スレッド）" }));
      for (const list of groups.values()) {
        for (const t of list) sec.append(topicItem(t, true));
      }
      nav.append(sec);
    }

    if (resolved.length) {
      const sec = el("div", { class: "nav-section" }, el("div", { class: "nav-heading", text: "解決済み" }));
      for (const t of resolved) sec.append(topicItem(t, true));
      nav.append(sec);
    }
  }

  /* ---------- views ---------- */
  function setHeader(title, desc, zulipHref, composerText, note) {
    $("composer-note").textContent = note || "Zulip でこのトピックが開きます。書き込みには Zulip のアカウントが必要です。";
    $("view-title").textContent = title;
    $("view-desc").textContent = desc || "";
    $("open-zulip").href = zulipHref;
    $("composer").href = zulipHref;
    $("composer-placeholder").textContent = composerText;
    document.title = `${title} | ${state.config.title} Zulip ビューア`;
  }

  function showFeed() {
    const all = state.data.messages;
    const list = all.slice(Math.max(0, all.length - state.feedLimit));
    const tl = $("timeline");
    tl.replaceChildren();
    setHeader("新着（すべての話題）", `${state.config.subtitle} の全トピックを時系列で表示`, channelUrl(), `#${state.config.channel.name} チャンネルに書き込む`,
      "Zulip で Japan チャンネルが開きます。トピック名を空のまま送ると「一般チャット」に入ります。");

    const actions = el("div", { class: "view-actions" },
      el("button", { class: "link-btn", type: "button", text: "すべて既読にする", onclick: () => { markAllSeen(); render(); } }));
    if (list.length < all.length) {
      tl.append(el("div", { class: "load-more" }, el("button", {
        class: "btn btn-ghost", type: "button", text: "さらに古いメッセージを読み込む",
        onclick: () => { state.feedLimit += FEED_PAGE; render({ keepScroll: true }); },
      })));
    }
    tl.append(actions);
    if (!list.length) { tl.append(el("div", { class: "empty", text: "まだメッセージはありません。" })); return; }
    tl.append(renderMessages(list, { showTopic: true, newAfter: { ...state.seen } }));
  }

  function showTopic(route) {
    const name = route.topic;
    const list = state.byTopic.get(name) || [];
    const p = state.pinnedByTopic.get(name);
    const t = state.topics.get(name);
    const label = topicLabel(name);
    const desc = p ? p.description + (name ? `（トピック: ${name}）` : "（トピック名なし＝一般チャット）") : (t ? `${t.count}件のメッセージ` : "");
    const zulip = topicUrl(name, t ? lastAnyId(t) : null);
    setHeader(label, desc, zulip, `「${label.replace(/^# /, "")}」に返信する`);

    const seenBefore = state.seen[name] || 0;
    const tl = $("timeline");
    tl.replaceChildren();
    if (!list.length) {
      tl.append(el("div", { class: "empty", text: "このトピックにはまだメッセージがありません。最初の投稿は Zulip からどうぞ。" }));
    } else {
      tl.append(renderMessages(list, { newAfter: seenBefore && t && t.last_id > seenBefore ? { [name]: seenBefore } : null }));
    }
    markSeen(name);
  }

  function showSearch(route) {
    const q = route.q.trim();
    $("search-input").value = q;
    const tl = $("timeline");
    tl.replaceChildren();
    setHeader(`検索: ${q}`, "Japan チャンネル内（本文・トピック名・投稿者）", channelUrl(), `#${state.config.channel.name} チャンネルに書き込む`);
    if (!q) return;
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = state.data.messages.filter((m) => {
      if (m.sys) return false;
      const hay = `${m._text}\n${m.topic}\n${state.users[m.sender]?.name || ""}`.toLowerCase();
      return terms.every((w) => hay.includes(w));
    });
    tl.append(el("div", { class: "result-head", text: `${hits.length}件` }));
    if (!hits.length) { tl.append(el("div", { class: "empty", text: "見つかりませんでした。" })); return; }
    tl.append(renderMessages(hits.slice(-300), { showTopic: true }));
  }

  function render(opts = {}) {
    const route = parseRoute();
    const tl = $("timeline");
    const prevHeight = tl.scrollHeight, prevTop = tl.scrollTop;
    renderNav(route);
    if (route.view === "topic") showTopic(route);
    else if (route.view === "search") showSearch(route);
    else showFeed();
    if (route.view !== "search") $("search-input").value = "";

    requestAnimationFrame(() => {
      if (opts.keepScroll) { tl.scrollTop = tl.scrollHeight - prevHeight + prevTop; return; }
      if (route.view === "topic" && route.msgId) {
        const target = document.getElementById(`m${route.msgId}`);
        if (target) {
          target.scrollIntoView({ block: "center" });
          target.classList.add("flash");
          return;
        }
      }
      const marker = tl.querySelector(".new-divider");
      if (marker && route.view !== "search") marker.scrollIntoView({ block: "start" });
      else if (route.view === "search") tl.scrollTop = tl.scrollHeight;
      else tl.scrollTop = tl.scrollHeight;
    });
    renderNav(route); // 既読反映
  }

  /* ---------- mobile nav ---------- */
  function openNav() { $("app").classList.add("nav-open"); $("scrim").hidden = false; $("menu-btn").setAttribute("aria-expanded", "true"); }
  function closeNav() { $("app").classList.remove("nav-open"); $("scrim").hidden = true; $("menu-btn").setAttribute("aria-expanded", "false"); }

  /* ---------- sidebar resize (desktop) ---------- */
  const SIDE_KEY = "rosjp-zulip:sidebar-width";
  const SIDE_DEFAULT = 280;
  const SIDE_MIN = 200;
  const sideMax = () => Math.max(SIDE_MIN, Math.min(640, Math.floor(window.innerWidth * 0.6)));

  function setSideWidth(w, save) {
    const width = Math.round(Math.min(sideMax(), Math.max(SIDE_MIN, w)));
    document.documentElement.style.setProperty("--side-w", `${width}px`);
    const r = $("resizer");
    r.setAttribute("aria-valuenow", String(width));
    r.setAttribute("aria-valuemin", String(SIDE_MIN));
    r.setAttribute("aria-valuemax", String(sideMax()));
    if (save) { try { localStorage.setItem(SIDE_KEY, String(width)); } catch { /* ignore */ } }
    return width;
  }

  function setupResizer() {
    const r = $("resizer");
    let saved = null;
    try { saved = Number(localStorage.getItem(SIDE_KEY)) || null; } catch { /* ignore */ }
    setSideWidth(saved || SIDE_DEFAULT, false);

    let dragging = false;
    const sidebarLeft = () => $("sidebar").getBoundingClientRect().left;
    r.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      try { r.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      document.body.classList.add("resizing");
      ev.preventDefault();
    });
    r.addEventListener("pointermove", (ev) => {
      if (dragging) setSideWidth(ev.clientX - sidebarLeft(), false);
    });
    const end = (ev) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("resizing");
      try { r.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      setSideWidth(ev.clientX - sidebarLeft(), true);
    };
    r.addEventListener("pointerup", end);
    r.addEventListener("pointercancel", end);
    r.addEventListener("dblclick", () => {
      setSideWidth(SIDE_DEFAULT, false);
      try { localStorage.removeItem(SIDE_KEY); } catch { /* ignore */ }
    });
    r.addEventListener("keydown", (ev) => {
      const cur = $("sidebar").getBoundingClientRect().width;
      const step = ev.shiftKey ? 64 : 16;
      if (ev.key === "ArrowLeft") { setSideWidth(cur - step, true); ev.preventDefault(); }
      else if (ev.key === "ArrowRight") { setSideWidth(cur + step, true); ev.preventDefault(); }
      else if (ev.key === "Home") { setSideWidth(SIDE_DEFAULT, true); ev.preventDefault(); }
    });
    // ウィンドウを狭めたときに本文が潰れないよう上限に合わせて縮める
    window.addEventListener("resize", () => {
      const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--side-w"), 10);
      if (cur > sideMax()) setSideWidth(sideMax(), false);
    });
  }

  /* ---------- boot ---------- */
  async function getJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  function index() {
    const { data, config } = state;
    state.users = data.users || {};
    state.topics = new Map(data.topics.map((t) => [t.name, t]));
    state.byTopic = new Map();
    const strip = document.createElement("div");
    for (const m of data.messages) {
      if (!state.byTopic.has(m.topic)) state.byTopic.set(m.topic, []);
      state.byTopic.get(m.topic).push(m);
      strip.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(m.html) : "";
      m._text = strip.textContent || "";
    }
    state.pinnedByTopic = new Map(config.pinned.map((p) => [p.topic, p]));

    const saved = loadSeen();
    if (saved) state.seen = saved;
    else { state.seen = {}; markAllSeen(); } // 初回訪問は全部既読扱い
  }

  function updateFooter() {
    const ts = state.data.generated_at;
    $("updated").textContent = `最終更新 ${fmtFull(ts)}（${fmtAgo(ts)}）`;
  }

  async function boot() {
    setupResizer();
    try {
      state.config = await getJSON("config.json");
      $("ws-name").textContent = state.config.title;
      $("ws-sub").textContent = state.config.subtitle;
      state.data = await getJSON("data/channel.json");
    } catch (e) {
      $("timeline").replaceChildren(el("div", { class: "empty", text: `データを読み込めませんでした（${e.message}）。` }));
      $("updated").textContent = "読み込み失敗";
      return;
    }
    index();
    updateFooter();
    setInterval(updateFooter, 60000);

    window.addEventListener("hashchange", () => render());
    $("search-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const q = $("search-input").value.trim();
      location.hash = q ? `#/search/${encodeURIComponent(q)}` : "#/";
    });
    $("menu-btn").addEventListener("click", openNav);
    $("scrim").addEventListener("click", closeNav);
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeNav(); });
    render();
  }

  boot();
})();
