(() => {
  if (window.__rwcActive) return;
  window.__rwcActive = true;

  // 集計対象のリアクション。aliasesには肌色バリエーションを除いた類似絵文字を含める。
  const REACTION_SET = [
    { id: "heart", glyph: "💖", aliases: ["💖", "❤", "💗", "🥰"] },
    { id: "thumb", glyph: "👍", aliases: ["👍"] },
    { id: "party", glyph: "🎉", aliases: ["🎉", "🥳"] },
    { id: "clap", glyph: "👏", aliases: ["👏"] },
    { id: "laugh", glyph: "😂", aliases: ["😂", "🤣"] },
    { id: "wow", glyph: "😮", aliases: ["😮", "😯", "😲"] },
    { id: "sad", glyph: "😢", aliases: ["😢", "😭"] },
    { id: "hmm", glyph: "🤔", aliases: ["🤔"] },
    { id: "down", glyph: "👎", aliases: ["👎"] }
  ];

  const reactionTotals = Object.fromEntries(REACTION_SET.map(r => [r.id, 0]));

  // 検出まわりの状態。
  const seenMarks = new WeakMap();      // element -> Set<reactionId>  (既に計上した種類)
  const callStamps = new WeakMap();     // announceノード -> {text, time} (読み上げの重複排除)
  let trackedSightings = [];            // [{element, id, time}]        (計上済みの目撃情報)
  let sightingLog = [];                 // [{id, time, matched}]        (通知照合用の履歴)
  let pendingCalls = [];                // [{id, text, time}]           (読み上げ通知の未照合分)
  let watchQueue = [];                  // [{element, ids, x, y, time, dormant}] (移動確認待ち)
  const burstTimes = [];

  let active = false;
  let panelOpen = false;
  let calmDownTimer = 0;
  let sweepTimer = 0;
  let sweepLoop = 0;
  let resolveTimer = 0;

  // ---- ウィジェットのDOM構築 ----
  const widget = document.createElement("aside");
  widget.id = "rwc-widget";
  widget.classList.add("rwc-hidden");

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "rwc-toggle";
  toggleButton.setAttribute("aria-label", "野鳥の会を表示");
  toggleButton.title = "野鳥の会を表示";
  toggleButton.textContent = "🔭";

  const stage = document.createElement("div");
  stage.className = "rwc-stage";

  const panel = document.createElement("section");
  panel.className = "rwc-panel";
  panel.title = "余白をドラッグして移動";

  const grid = document.createElement("div");
  grid.className = "rwc-grid";
  const tiles = {};
  for (const reaction of REACTION_SET) {
    const tile = document.createElement("div");
    tile.className = "rwc-tile";
    tile.dataset.reaction = reaction.id;
    const num = document.createElement("strong");
    num.textContent = "0";
    const glyph = document.createElement("span");
    glyph.textContent = reaction.glyph;
    tile.append(num, glyph);
    grid.appendChild(tile);
    tiles[reaction.id] = num;
  }
  panel.appendChild(grid);

  const mascot = document.createElement("div");
  mascot.className = "rwc-mascot";
  const calmImg = document.createElement("img");
  calmImg.className = "rwc-calm";
  calmImg.alt = "観察員";
  calmImg.src = chrome.runtime.getURL("assets/birdwatcher.png");
  const busyImg = document.createElement("img");
  busyImg.className = "rwc-busy";
  busyImg.alt = "慌てて数える観察員";
  busyImg.src = chrome.runtime.getURL("assets/birdwatcher-busy.png");
  mascot.append(calmImg, busyImg);
  for (let i = 1; i <= 4; i++) {
    const drop = document.createElement("span");
    drop.className = `rwc-sweat rwc-sweat-${i}`;
    mascot.appendChild(drop);
  }

  const resizeHandle = document.createElement("button");
  resizeHandle.type = "button";
  resizeHandle.className = "rwc-resize";
  resizeHandle.setAttribute("aria-label", "サイズ変更");
  resizeHandle.title = "ドラッグしてサイズ変更";

  stage.append(panel, mascot, resizeHandle);
  widget.append(toggleButton, stage);
  document.documentElement.appendChild(widget);

  function paintCount(id) {
    tiles[id].textContent = reactionTotals[id];
    const tile = widget.querySelector(`[data-reaction="${id}"]`);
    tile.classList.remove("rwc-pop");
    void tile.offsetWidth;
    tile.classList.add("rwc-pop");
  }

  function clearCounters() {
    for (const reaction of REACTION_SET) {
      reactionTotals[reaction.id] = 0;
      paintCount(reaction.id);
    }
    trackedSightings = [];
    sightingLog = [];
    pendingCalls = [];
    watchQueue = [];
    clearTimeout(sweepTimer); sweepTimer = 0;
    clearTimeout(resolveTimer); resolveTimer = 0;
  }

  function setActive(value) {
    active = value;
    widget.classList.toggle("rwc-active", value);
    if (!value) widget.classList.remove("rwc-rush");
    clearInterval(sweepLoop);
    // 定期スイープが取りこぼしの保険。通知を逃しても、アニメーション表示中
    // (数秒間)のどこかのスイープで必ず要素を再発見できる。
    sweepLoop = value ? setInterval(() => sweepStage(true), 400) : 0;
  }

  // 開いた時のパネル全体のレイアウト寸法(styles.cssと一致させること)。
  const OPEN_WIDTH = 410;
  const OPEN_HEIGHT = 300;
  const CLOSED_SIZE = 42;

  function setPanelOpen(value) {
    // 開閉の前後で望遠鏡/×ボタンが画面上の同じ位置(パネル右上)に留まるように、
    // ボタンの現在位置を基準へ、右上アンカーで配置し直す。
    const anchor = toggleButton.getBoundingClientRect();
    panelOpen = value;
    widget.classList.toggle("rwc-hidden", !value);
    const scale = Number(widget.dataset.scale || 1);
    const width = value ? OPEN_WIDTH * scale : CLOSED_SIZE;
    const height = value ? OPEN_HEIGHT * scale : CLOSED_SIZE;
    const right = Math.max(8, Math.min(innerWidth - anchor.right, innerWidth - width - 8));
    const top = Math.max(8, Math.min(anchor.top, innerHeight - height - 8));
    widget.style.left = "auto";
    widget.style.right = `${right}px`;
    widget.style.top = `${top}px`;
    toggleButton.setAttribute("aria-label", value ? "野鳥の会を非表示" : "野鳥の会を表示");
    toggleButton.title = value ? "非表示にしてリセット" : "表示してカウント開始";
    toggleButton.textContent = value ? "×" : "🔭";
    if (value) {
      clearCounters();
      // 表示開始時点ですでにあるリアクション表示を基準登録し、集計対象外にする。
      sweepStage(false);
      setActive(true);
    } else {
      setActive(false);
      clearCounters();
      burstTimes.length = 0;
      widget.classList.remove("rwc-spotting", "rwc-rush");
    }
  }

  function matchReactionIds(text) {
    const clean = String(text || "").replaceAll("\uFE0F", "").replace(/[🏻🏼🏽🏾🏿]/gu, "");
    const found = [];
    for (const reaction of REACTION_SET) {
      for (const alias of reaction.aliases) {
        const normalized = alias.replaceAll("\uFE0F", "");
        let at = 0;
        while ((at = clean.indexOf(normalized, at)) !== -1) { found.push(reaction.id); at += normalized.length; }
        if (found.at(-1) === reaction.id) break;
      }
    }
    // 受信側では絵文字ではなく、スクリーンリーダー向けの文言だけが届く場合がある。
    if (!found.length && /react|reaction|リアクション|反応/i.test(clean)) {
      const labelPatterns = [
        ["heart", /heart|love|ハート|好き/i], ["thumb", /thumbs? up|like|高評価|いいね/i],
        ["party", /celebrat|party|お祝い|クラッカー/i], ["clap", /clap|applause|拍手/i],
        ["laugh", /laugh|joy|笑/i], ["wow", /surpris|wow|驚/i],
        ["sad", /sad|cry|悲/i], ["hmm", /think|thinking|考/i], ["down", /thumbs? down|低評価/i]
      ];
      const hit = labelPatterns.find(([, pattern]) => pattern.test(clean));
      if (hit) found.push(hit[0]);
    }
    return found;
  }

  function creditSightings(tally) {
    const now = Date.now();
    for (const [id, amount] of Object.entries(tally)) {
      if (!amount) continue;
      reactionTotals[id] += amount;
      paintCount(id);
      for (let i = 0; i < amount; i++) burstTimes.push(now);
    }
    while (burstTimes.length && burstTimes[0] < now - 2200) burstTimes.shift();
    // クラスが付いたままだとCSSアニメーションは再始動しない。連続で届いたときも
    // 毎回揺れて見えるよう、一度外してリフローしてから付け直す。
    widget.classList.remove("rwc-spotting");
    void mascot.offsetWidth;
    widget.classList.add("rwc-spotting");
    if (burstTimes.length >= 4) widget.classList.add("rwc-rush");
    clearTimeout(calmDownTimer);
    calmDownTimer = setTimeout(() => widget.classList.remove("rwc-spotting", "rwc-rush"), 2400);
  }

  function collectText(element) {
    const direct = Array.from(element.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.nodeValue || "")
      .join("");
    return [direct, element.getAttribute("alt"), element.getAttribute("data-emoji"),
      element.getAttribute("aria-label"), element.getAttribute("title")].filter(Boolean).join(" ");
  }

  function rectOverlapRatio(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const intersection = width * height;
    const union = a.width * a.height + b.width * b.height - intersection;
    return union > 0 ? intersection / union : 0;
  }

  // リアクションパレット・メニュー・チャット欄・参加者一覧の中の絵文字は数えない。
  const IGNORE_SELECTOR = "button,[role=button],[role=menu],[role=menubar],[role=toolbar]," +
    "[role=dialog],[role=textbox],[contenteditable=true],[role=list],[role=listitem],[role=option],[role=tab]";

  // 「流れてきた」と判定する累計移動量。送信者タイル上の静止バッジ等は動かないので数えない。
  const DRIFT_THRESHOLD = 24;

  // 2つの要素が同じ小さなコンテナ(=1つのリアクションバブル)に入っているか。
  // 絵文字本体と名前チップのように、1バブル内へ横並びで置かれた重複表現を1件に統合する。
  // 別々のリアクションどうしの共通祖先はレーン全体になり、この大きさに収まらない。
  function inSameCluster(a, b) {
    const ancestors = new Set();
    let node = a;
    for (let i = 0; node && node !== document.body && i < 40; i++, node = node.parentElement) ancestors.add(node);
    let common = b;
    for (let i = 0; common && !ancestors.has(common) && i < 40; i++) common = common.parentElement;
    if (!common || common === document.body || common === document.documentElement) return false;
    const rect = common.getBoundingClientRect();
    return rect.width > 0 && rect.width <= 320 && rect.height <= 160;
  }

  function sweepStage(shouldTally = true) {
    if (shouldTally && !active) return;
    const now = Date.now();
    // DOMから外れた要素は追跡をやめる。要素が再利用されたら新しい1件として数え直す。
    trackedSightings = trackedSightings.filter(entry => {
      if (entry.element.isConnected) return true;
      seenMarks.delete(entry.element);
      return false;
    });

    const carriers = [];
    for (const element of document.body.querySelectorAll("span, div, img, [data-emoji], [aria-label]")) {
      const ids = matchReactionIds(collectText(element));
      if (!ids.length) continue;
      if (widget.contains(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8 || rect.width > 240 || rect.height > 240) continue;
      if (rect.right <= 0 || rect.left >= innerWidth) continue;
      if (rect.bottom <= -40 || rect.top >= innerHeight + 40) continue;
      if (element.closest(IGNORE_SELECTOR)) continue;
      if (element.checkVisibility) {
        if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      } else {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < .05) continue;
      }
      carriers.push({ element, ids: [...new Set(ids)], rect });
    }

    // Meetは1つのリアクションを包み(aria-label)と中身(img alt)の入れ子で二重に持つ。
    // 子孫にも絵文字を持つ要素は外側の重複表現なので、最も深い要素だけを代表にする。
    const deepestOnly = carriers.filter(a => !carriers.some(b => b !== a && a.element.contains(b.element)));

    // 数えるのは「流れてきた」もの、つまり初見位置から動いた要素だけ。
    // 送信者タイル上の静止バッジのような、動かない付随表示はここで落ちる。
    watchQueue = watchQueue.filter(pending => pending.element.isConnected);
    const readyToCount = [];
    for (const { element, ids, rect } of deepestOnly) {
      const done = seenMarks.get(element);
      const remaining = ids.filter(id => !(done && done.has(id)));
      if (!remaining.length) continue;
      if (!shouldTally) {
        // 表示開始時の基準登録: いま見えているものは動かなくても集計対象外として記録する。
        const marks = done || new Set();
        remaining.forEach(id => marks.add(id));
        seenMarks.set(element, marks);
        trackedSightings.push(...remaining.map(id => ({ element, id, time: now })));
        continue;
      }
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const watched = watchQueue.find(pending => pending.element === element);
      if (!watched) {
        watchQueue.push({ element, ids: remaining, x: cx, y: cy, time: now, dormant: false });
        continue;
      }
      if (watched.dormant) continue;
      if (Math.abs(cx - watched.x) + Math.abs(cy - watched.y) < DRIFT_THRESHOLD) {
        // 5秒動かないものは静止表示とみなし、消えるまで監視だけ続ける。
        if (now - watched.time > 5000) watched.dormant = true;
        continue;
      }
      readyToCount.push({ element, ids: remaining, rect });
    }

    const tally = {};
    for (const { element, ids, rect } of readyToCount) {
      for (const id of ids) {
        // 同じバブル内の重複表現(絵文字本体+名前チップ等)は1件に統合する。恒久的な重複なので
        // カウント済み扱いにする。座標がほぼ一致し続けるだけの内部コピーも同様に抑制するが、
        // こちらは近接した別リアクションの可能性が残るため、離れたら数えられるよう保留に留める。
        let permanentDup = false;
        let transientDup = false;
        for (const entry of trackedSightings) {
          if (entry.id !== id || entry.element === element || !entry.element.isConnected) continue;
          if (inSameCluster(element, entry.element)) { permanentDup = true; break; }
          if (rectOverlapRatio(rect, entry.element.getBoundingClientRect()) >= .8) transientDup = true;
        }
        if (transientDup && !permanentDup) continue;
        const marks = seenMarks.get(element) || new Set();
        marks.add(id);
        seenMarks.set(element, marks);
        if (permanentDup) continue;
        trackedSightings.push({ element, id, time: now });
        sightingLog.push({ id, time: now, matched: false });
        tally[id] = (tally[id] || 0) + 1;
      }
    }
    sightingLog = sightingLog.filter(entry => now - entry.time < 6000);
    if (shouldTally && Object.values(tally).some(Boolean)) creditSightings(tally);
  }

  function scheduleSweep() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(() => { sweepTimer = 0; sweepStage(true); }, 40);
  }

  // ---- 読み上げ通知との突き合わせ(目視カウントの保険) ----
  // Meetはリアクションをaria-liveでも通知する。通知1件につき±2.6秒以内の
  // 目視カウント1件を消し込み、目視が1件も無かった通知だけを補完カウントする。
  function parseAnnouncement(node) {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || !el.closest("[aria-live],[role=status],[role=log],[role=alert]")) return null;
    let text;
    if (node.nodeType === Node.TEXT_NODE) {
      text = node.nodeValue || "";
    } else if (node instanceof Element) {
      const labels = Array.from(node.querySelectorAll("img[alt], [data-emoji], [aria-label]"))
        .map(child => [child.getAttribute("alt"), child.getAttribute("data-emoji"), child.getAttribute("aria-label")].filter(Boolean).join(" "));
      text = [(node.textContent || "").slice(0, 2000), collectText(node), ...labels].join(" ");
    } else {
      return [];
    }
    const stamp = callStamps.get(node);
    const now = Date.now();
    if (stamp && stamp.text === text && now - stamp.time < 1200) return [];
    callStamps.set(node, { text, time: now });
    const ids = [...new Set(matchReactionIds(text))];
    if (!ids.length) return [];
    // チャットメッセージ内の絵文字を補完対象にしない。リアクションらしい文言か、
    // 絵文字だけの通知のときに限って保険を発動する。
    if (/message|メッセージ|チャット|chat/i.test(text)) return [];
    const residual = String(text)
      .replace(/[️‍🏻🏼🏽🏾🏿]/gu, "").replace(/\p{Extended_Pictographic}|\s/gu, "");
    const reactionLike = /react|リアクション/i.test(text) || residual.length === 0;
    return reactionLike ? ids.map(id => ({ id, text: text.trim() })) : [];
  }

  function enqueueCall({ id, text }) {
    const now = Date.now();
    // 複数のaria-live領域は同じ通知文をほぼ同時に重複して持つので、同文・同種は1件に統合する。
    // 別人の連続リアクションは通知文(送信者名の部分)が異なるため、時間が近くても両方数える。
    if (pendingCalls.some(pending =>
      pending.id === id && pending.text === text && now - pending.time < 800)) return;
    pendingCalls.push({ id, text, time: now });
    scheduleResolve();
  }

  function scheduleResolve() {
    if (resolveTimer) return;
    resolveTimer = setTimeout(() => {
      resolveTimer = 0;
      const now = Date.now();
      const remain = [];
      const fallback = {};
      for (const pending of pendingCalls) {
        // 目視カウントは移動確認を経るため通知より1秒前後遅れる。照合窓(±2.6秒)が
        // 閉じてから判定する。早く判定すると同じ1件を通知と目視で二重に数えてしまう。
        if (now - pending.time < 2700) { remain.push(pending); continue; }
        const match = sightingLog.find(entry =>
          !entry.matched && entry.id === pending.id && Math.abs(entry.time - pending.time) <= 2600);
        if (match) match.matched = true;
        else fallback[pending.id] = (fallback[pending.id] || 0) + 1;
      }
      pendingCalls = remain;
      if (active && Object.values(fallback).some(Boolean)) creditSightings(fallback);
      if (pendingCalls.length) scheduleResolve();
    }, 300);
  }

  function looksReactionish(node) {
    if (node.nodeType === Node.TEXT_NODE) return matchReactionIds(node.nodeValue || "").length > 0;
    if (!(node instanceof Element)) return false;
    if (matchReactionIds(collectText(node)).length) return true;
    if (matchReactionIds((node.textContent || "").slice(0, 20000)).length) return true;
    for (const el of node.querySelectorAll("img[alt], [data-emoji], [aria-label]")) {
      const value = [el.getAttribute("alt"), el.getAttribute("data-emoji"), el.getAttribute("aria-label")].filter(Boolean).join(" ");
      if (matchReactionIds(value).length) return true;
    }
    return false;
  }

  const watcher = new MutationObserver(mutations => {
    if (!active) return;
    let needsSweep = false;
    for (const mutation of mutations) {
      const nodes = mutation.type === "childList" ? mutation.addedNodes : [mutation.target];
      for (const node of nodes) {
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!el || widget.contains(el)) continue;
        const announcement = parseAnnouncement(node);
        if (announcement === null) {
          // 通常DOMの変化。絵文字が関わるときだけ即時スキャンを予約する
          // (定期スイープもあるので、ここで拾えなくても取りこぼさない)。
          if (!needsSweep && looksReactionish(node)) needsSweep = true;
        } else {
          announcement.forEach(enqueueCall);
        }
      }
    }
    if (needsSweep) scheduleSweep();
  });
  watcher.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "alt", "data-emoji", "title"] });

  // ---- 操作: 開閉・移動・リサイズ ----
  toggleButton.onclick = () => {
    if (toggleButton.dataset.dragged === "1") { toggleButton.dataset.dragged = "0"; return; }
    setPanelOpen(!panelOpen);
  };

  // 望遠鏡/×ボタンは、掴んで動かせばウィジェットごと移動、動かさず離せば開閉。
  let toggleDrag = null;
  toggleButton.onpointerdown = e => {
    toggleDrag = { x: e.clientX, y: e.clientY, rect: widget.getBoundingClientRect() };
    toggleButton.dataset.dragged = "0";
    toggleButton.setPointerCapture(e.pointerId);
  };
  toggleButton.onpointermove = e => {
    if (!toggleDrag) return;
    const dx = e.clientX - toggleDrag.x;
    const dy = e.clientY - toggleDrag.y;
    // 数px以内のぶれはクリック扱いにして、意図しない移動と開閉抑止を防ぐ。
    if (toggleButton.dataset.dragged !== "1" && Math.abs(dx) + Math.abs(dy) < 5) return;
    toggleButton.dataset.dragged = "1";
    const { rect } = toggleDrag;
    const right = Math.max(8, Math.min(innerWidth - (rect.right + dx), innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(rect.top + dy, innerHeight - rect.height - 8));
    widget.style.left = "auto";
    widget.style.right = `${right}px`;
    widget.style.top = `${top}px`;
  };
  toggleButton.onpointerup = toggleButton.onpointercancel = () => { toggleDrag = null; };

  let panelDrag = null;
  widget.onpointerdown = e => {
    if (e.target.closest("button")) return;
    const rect = widget.getBoundingClientRect();
    panelDrag = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    widget.setPointerCapture(e.pointerId);
  };
  widget.onpointermove = e => {
    if (!panelDrag) return;
    const rect = widget.getBoundingClientRect();
    widget.style.right = "auto";
    widget.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, e.clientX - panelDrag.x))}px`;
    widget.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, e.clientY - panelDrag.y))}px`;
  };
  widget.onpointerup = () => { panelDrag = null; };

  let resizeDrag = null;
  resizeHandle.onpointerdown = e => {
    e.stopPropagation();
    resizeDrag = { x: e.clientX, y: e.clientY, scale: Number(widget.dataset.scale || 1) };
    resizeHandle.setPointerCapture(e.pointerId);
  };
  resizeHandle.onpointermove = e => {
    if (!resizeDrag) return;
    e.stopPropagation();
    const delta = ((e.clientX - resizeDrag.x) + (e.clientY - resizeDrag.y)) / 520;
    const scale = Math.max(.6, Math.min(1.6, resizeDrag.scale + delta));
    widget.dataset.scale = scale.toFixed(2);
    widget.style.setProperty("--rwc-scale", scale);
  };
  resizeHandle.onpointerup = e => { e.stopPropagation(); resizeDrag = null; };
})();
