/* 발표세션(키노트) 카드의 PixelGrid 설정.
 *
 * 모양은 dna26-pixelgrid 플레이그라운드의 config 객체와 똑같습니다.
 * 플레이그라운드에서 "복사" 로 받은 JSON 을 아래 중괄호 안에 그대로
 * 붙여넣으면 됩니다. (font 는 비워두면 엔진 기본 글꼴을 씁니다)
 *
 * 사이트에서 직접 조절하려면 주소 끝에 ?tune 을 붙이세요.
 */
window.DNA26_KEYNOTE = {
  /* 네 카드가 함께 쓰는 그리드 값 */
  grid: {
    pitch: 4.25,
    gap: 0.21,
    radius: 0,
    quantize: 0,
    minAlpha: 0.11,
    color: "#ffffff",
    seed: 7,
    flicker: { amp: 0.28, minPeriod: 4.4, maxPeriod: 4 },
    transition: { duration: 800, scatter: 1.8, stagger: 0.35, dip: 0.3, out: 0.4 },
    autoCycle: 10000,
    reducedMotion: "auto"
  },

  /* 1번 카드 — 지구본 */
  globe: {
    radius: 0.46, cx: 0.5, cy: 0.5, period: 20, direction: 1, tilt: 0,
    lon0: 0, edge: 0.35, ocean: 0.3, land: 1, supersample: 3,
    grid: {}
  },

  /* 2번 카드 — 문자 */
  text: {
    glyphs: ["가", "あ", "道", "A"],
    style: {
      weight: 800, size: 0.62, depth: 2.2, spin: true, period: 10,
      angle: 32, tilt: 0.35, faceBright: 1, backBright: 0.6,
      sideBright: 0.45, sideFade: 0.5, maxWidth: 0.92,
      supersample: 3, gain: 1, gamma: 1, floor: 0.02
    },
    grid: { transition: { duration: 1400 }, autoCycle: 6000 }
  },

  /* 3번 카드 — 얼굴 */
  faces: {
    fit: "contain", scale: 0.92, gain: 1, gamma: 1, floor: 0.02,
    motion: { spinPeriod: 0, swayX: 1.2, swayY: 0.6, swayPeriod: 5, zoomAmp: 0.06, zoomPeriod: 7 },
    grid: { transition: { duration: 1800 }, autoCycle: 4500 }
  },

  /* 4번 카드 — 전구 */
  bulb: {
    period: 10, pulsePeriod: 2.6, glow: 1, rays: 1, size: 1,
    glass: 0.16, turns: 16, cy: 0.44, supersample: 3,
    gain: 1, gamma: 1, floor: 0.02,
    grid: {}
  }
};
