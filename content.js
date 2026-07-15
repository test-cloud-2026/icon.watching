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
  const burstTimes = [];

  let active = false;
  let panelOpen = false;
  let calmDownTimer = 0;

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
  }

  function setActive(value) {
    active = value;
    widget.classList.toggle("rwc-active", value);
    if (!value) widget.classList.remove("rwc-rush");
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
      setActive(true);
    } else {
      setActive(false);
      clearCounters();
      burstTimes.length = 0;
      widget.classList.remove("rwc-spotting", "rwc-rush");
    }
  }

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
