/* 발표세션 카드 PixelGrid 조절 패널.
 *
 * 주소 끝에 ?tune 을 붙이면 실제 카드 위에서 값을 바꿔 보고,
 * 마음에 드는 값을 keynote.config.js 에 넣을 수 있게 복사해 줍니다.
 * 일반 방문자에게는 불러오지 않습니다.
 */
(() => {
  "use strict";

  const API = window.DNA26_TUNE;
  if (!API || !window.DNA26_KEYNOTE) return;

  const LS = "dna26.keynote.tune";
  const BUILT_IN = JSON.parse(JSON.stringify(window.DNA26_KEYNOTE));

  // 작업하던 값이 있으면 이어서
  try {
    const saved = JSON.parse(localStorage.getItem(LS) || "null");
    if (saved) { Object.assign(window.DNA26_KEYNOTE, saved); API.mount(); }
  } catch (e) {}

  /* 어떤 값을 어떤 범위로 조절할지 — [경로, 이름, 최소, 최대, 단계] */
  const TABS = {
    "공통": [
      ["grid.pitch", "셀 간격", 2, 10, 0.25],
      ["grid.gap", "셀 사이 여백", 0, 0.6, 0.01],
      ["grid.radius", "셀 둥글기", 0, 0.5, 0.01],
      ["grid.minAlpha", "최소 밝기", 0, 0.2, 0.005],
      ["grid.flicker.amp", "깜빡임 세기", 0, 0.5, 0.01],
      ["grid.flicker.minPeriod", "깜빡임 주기 최소", 0.5, 6, 0.1],
      ["grid.flicker.maxPeriod", "깜빡임 주기 최대", 1, 10, 0.1],
      ["grid.transition.duration", "전환 시간(ms)", 200, 3000, 50],
      ["grid.transition.scatter", "흩어짐", 0, 2, 0.05],
      ["grid.transition.stagger", "번짐", 0, 1, 0.01],
      ["grid.transition.dip", "전환 중 어두워짐", 0, 1, 0.01],
      ["grid.transition.out", "빠지는 비율", 0, 1, 0.01],
      ["grid.autoCycle", "자동 전환(ms)", 0, 20000, 500]
    ],
    "지구본": [
      ["globe.radius", "크기", 0.2, 0.6, 0.01],
      ["globe.cx", "가로 위치", 0.2, 0.8, 0.01],
      ["globe.cy", "세로 위치", 0.2, 0.8, 0.01],
      ["globe.period", "한 바퀴(초)", 4, 60, 1],
      ["globe.tilt", "기울기", -40, 40, 1],
      ["globe.edge", "가장자리", 0, 1, 0.01],
      ["globe.ocean", "바다 밝기", 0, 1, 0.01],
      ["globe.land", "육지 밝기", 0, 1.5, 0.01],
      ["globe.grid.autoCycle", "자동 전환(ms)", 0, 20000, 500]
    ],
    "문자": [
      ["text.style.size", "글자 크기", 0.3, 1, 0.01],
      ["text.style.depth", "두께", 0, 6, 0.1],
      ["text.style.period", "한 바퀴(초)", 3, 30, 0.5],
      ["text.style.angle", "각도", 0, 90, 1],
      ["text.style.tilt", "기울기", -1, 1, 0.01],
      ["text.style.faceBright", "앞면 밝기", 0, 1.5, 0.01],
      ["text.style.backBright", "뒷면 밝기", 0, 1.5, 0.01],
      ["text.style.sideBright", "옆면 밝기", 0, 1.5, 0.01],
      ["text.style.sideFade", "옆면 감쇠", 0, 1, 0.01],
      ["text.grid.transition.duration", "전환 시간(ms)", 200, 3000, 50],
      ["text.grid.autoCycle", "자동 전환(ms)", 0, 20000, 500]
    ],
    "얼굴": [
      ["faces.scale", "크기", 0.5, 1.2, 0.01],
      ["faces.gain", "밝기", 0.5, 2, 0.01],
      ["faces.gamma", "감마", 0.4, 2.5, 0.01],
      ["faces.floor", "최소 밝기", 0, 0.2, 0.005],
      ["faces.motion.swayX", "좌우 흔들림", 0, 4, 0.1],
      ["faces.motion.swayY", "상하 흔들림", 0, 4, 0.1],
      ["faces.motion.swayPeriod", "흔들림 주기(초)", 1, 15, 0.5],
      ["faces.motion.zoomAmp", "줌 크기", 0, 0.3, 0.005],
      ["faces.motion.zoomPeriod", "줌 주기(초)", 1, 20, 0.5],
      ["faces.grid.transition.duration", "전환 시간(ms)", 200, 3000, 50],
      ["faces.grid.autoCycle", "자동 전환(ms)", 0, 20000, 500]
    ],
    "전구": [
      ["bulb.period", "한 바퀴(초)", 3, 30, 0.5],
      ["bulb.pulsePeriod", "숨쉬기(초)", 0.5, 10, 0.1],
      ["bulb.glow", "후광", 0, 2, 0.01],
      ["bulb.rays", "빛줄기", 0, 2, 0.01],
      ["bulb.size", "크기", 0.5, 1.5, 0.01],
      ["bulb.glass", "유리", 0, 0.5, 0.005],
      ["bulb.turns", "나사산", 4, 30, 1],
      ["bulb.cy", "세로 위치", 0.2, 0.8, 0.01],
      ["bulb.grid.autoCycle", "자동 전환(ms)", 0, 20000, 500]
    ]
  };

  const get = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), window.DNA26_KEYNOTE);
  function set(path, v) {
    const keys = path.split(".");
    let o = window.DNA26_KEYNOTE;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] || (o[keys[i]] = {});
    o[keys[keys.length - 1]] = v;
  }

  /* ── 패널 ── */
  const css = `
  #pgTune { position: fixed; z-index: 999; right: 0; top: 0; bottom: 0; width: 300px;
    background: #111; color: #ddd; font: 12px/1.45 -apple-system, system-ui, sans-serif;
    border-left: 1px solid #2a2a2a; display: flex; flex-direction: column; }
  #pgTune.min { transform: translateX(calc(100% - 40px)); }
  #pgTune h2 { font-size: 12px; font-weight: 600; color: #fff; padding: 10px 12px; margin: 0;
    border-bottom: 1px solid #2a2a2a; display: flex; align-items: center; gap: 8px; }
  #pgTune h2 button { margin-left: auto; background: #222; border: 1px solid #333; color: #aaa;
    border-radius: 5px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
  #pgTabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 10px; border-bottom: 1px solid #2a2a2a; }
  #pgTabs button { background: #1c1c1c; border: 1px solid #2e2e2e; color: #999; border-radius: 999px;
    padding: 3px 10px; cursor: pointer; font-size: 11px; }
  #pgTabs button.on { background: #fff; border-color: #fff; color: #000; }
  #pgBody { flex: 1; overflow-y: auto; padding: 6px 12px 12px; }
  .pgRow { padding: 7px 0; border-bottom: 1px solid #1e1e1e; }
  .pgRow label { display: flex; justify-content: space-between; gap: 8px; color: #bbb; }
  .pgRow b { color: #fff; font-weight: 600; font-variant-numeric: tabular-nums; }
  .pgRow input[type=range] { width: 100%; margin-top: 5px; accent-color: #fff; }
  #pgFoot { border-top: 1px solid #2a2a2a; padding: 10px 12px; display: grid; gap: 6px; }
  #pgFoot .r { display: flex; gap: 6px; }
  #pgFoot button { flex: 1; background: #1c1c1c; border: 1px solid #333; color: #ddd;
    border-radius: 6px; padding: 7px 6px; cursor: pointer; font-size: 11.5px; }
  #pgFoot button.p { background: #fff; border-color: #fff; color: #000; font-weight: 600; }
  #pgMsg { color: #7fd07f; min-height: 15px; font-size: 11px; }
  #pgJson { width: 100%; height: 90px; background: #0a0a0a; color: #9ad; border: 1px solid #2a2a2a;
    border-radius: 6px; font: 10.5px/1.4 ui-monospace, Menlo, monospace; padding: 6px; resize: vertical; }

  /* 좁은 화면에서는 아래쪽 시트로 — 카드가 위에 보이게 */
  @media (max-width: 720px) {
    #pgTune { left: 0; right: 0; top: auto; bottom: 0; width: auto; height: 52vh;
      border-left: 0; border-top: 1px solid #2a2a2a; border-radius: 12px 12px 0 0; }
    #pgTune.min { transform: translateY(calc(100% - 38px)); }
    #pgJson { height: 60px; }
  }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const el = document.createElement("div");
  el.id = "pgTune";
  el.innerHTML = `
    <h2>픽셀그리드 조절 <button id="pgMin">숨기기</button></h2>
    <div id="pgTabs"></div>
    <div id="pgBody"></div>
    <div id="pgFoot">
      <div class="r">
        <button id="pgGo">키노트로</button>
        <button id="pgReset">기본값</button>
      </div>
      <div class="r">
        <button id="pgSave" class="p">저장</button>
        <button id="pgCopy">JSON 복사</button>
      </div>
      <textarea id="pgJson" spellcheck="false" placeholder="여기에 플레이그라운드 JSON 을 붙여넣고 '적용'"></textarea>
      <div class="r"><button id="pgApply">붙여넣은 JSON 적용</button></div>
      <div id="pgMsg"></div>
    </div>`;
  document.body.appendChild(el);

  const $ = (id) => document.getElementById(id);
  const msg = (t) => { $("pgMsg").textContent = t; clearTimeout(msg._t); msg._t = setTimeout(() => ($("pgMsg").textContent = ""), 2400); };

  let tab = "공통";
  let timer = 0;
  const apply = () => { clearTimeout(timer); timer = setTimeout(() => API.mount(), 70); };

  function renderTabs() {
    $("pgTabs").innerHTML = "";
    Object.keys(TABS).forEach((name) => {
      const b = document.createElement("button");
      b.textContent = name;
      if (name === tab) b.className = "on";
      b.onclick = () => { tab = name; renderTabs(); renderBody(); };
      $("pgTabs").appendChild(b);
    });
  }

  function renderBody() {
    const body = $("pgBody");
    body.innerHTML = "";
    TABS[tab].forEach(([path, label, min, max, step]) => {
      let v = get(path);
      if (v === undefined) { v = min; set(path, v); }
      const row = document.createElement("div");
      row.className = "pgRow";
      row.innerHTML = `<label>${label}<b></b></label><input type="range" min="${min}" max="${max}" step="${step}">`;
      const out = row.querySelector("b");
      const rng = row.querySelector("input");
      rng.value = v;
      out.textContent = v;
      rng.oninput = () => {
        const n = parseFloat(rng.value);
        out.textContent = n;
        set(path, n);
        apply();
      };
      body.appendChild(row);
    });
  }

  $("pgMin").onclick = () => {
    el.classList.toggle("min");
    $("pgMin").textContent = el.classList.contains("min") ? "펼치기" : "숨기기";
  };

  $("pgGo").onclick = () => {
    const deck = document.getElementById("deck");
    const span = deck.offsetHeight - window.innerHeight;
    // STATS_UNITS=434, CARD_UNIT=130, 총 434+1170
    const units = 434 + (API.pageIndex - 1 + 0.55) * 130;
    window.scrollTo({ top: deck.offsetTop + span * (units / 1604), behavior: "smooth" });
  };

  $("pgReset").onclick = () => {
    Object.assign(window.DNA26_KEYNOTE, JSON.parse(JSON.stringify(BUILT_IN)));
    localStorage.removeItem(LS);
    renderBody(); API.mount(); msg("기본값으로 되돌렸습니다");
  };

  $("pgSave").onclick = () => {
    try {
      localStorage.setItem(LS, JSON.stringify(window.DNA26_KEYNOTE));
      msg("이 기기에 저장했습니다 — 사이트에 반영하려면 JSON 을 복사해 전달하세요");
    } catch (e) { msg("저장 실패"); }
  };

  $("pgCopy").onclick = async () => {
    const text = JSON.stringify(window.DNA26_KEYNOTE, null, 2);
    $("pgJson").value = text;
    try { await navigator.clipboard.writeText(text); msg("복사했습니다"); }
    catch (e) { $("pgJson").select(); msg("아래 칸에서 직접 복사하세요"); }
  };

  $("pgApply").onclick = () => {
    try {
      const o = JSON.parse($("pgJson").value);
      Object.assign(window.DNA26_KEYNOTE, o);
      renderBody(); API.mount(); msg("적용했습니다");
    } catch (e) { msg("JSON 을 읽지 못했습니다"); }
  };

  renderTabs();
  renderBody();
  setTimeout(() => $("pgGo").click(), 300);
})();
