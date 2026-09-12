/*! PixelGrid v0.1 — vanilla Canvas 2D pixel-grid animation engine (jongwon.ai)
 *  no dependencies. usage:
 *    const grid = PixelGrid.mount(el, { designWidth: 278, pitch: 4, scenes: [ PixelGrid.scenes.globe(), ... ] });
 *    grid.go('globe'); grid.next(); grid.set({ gap: 0.25 }); grid.pause(); grid.resume(); grid.destroy();
 */
(function (global) {
  "use strict";

  const PG = global.PixelGrid || (global.PixelGrid = {});
  PG.assets = PG.assets || {};
  PG.scenes = PG.scenes || {};
  PG.version = "0.4.0";

  /* ── utils ─────────────────────────────────────────── */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const TAU = Math.PI * 2;

  // deterministic rng so the same seed gives the same flicker/scatter pattern
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function toU8(data) {
    if (data instanceof Uint8Array) return data;
    if (Array.isArray(data)) return Uint8Array.from(data);
    const bin = global.atob(String(data));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof Float32Array); }
  function mergeInto(target, patch) {
    for (const k in patch) {
      const v = patch[k];
      if (isObj(v) && isObj(target[k])) mergeInto(target[k], v);
      else target[k] = v;
    }
    return target;
  }
  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  // area-averaging resample of a cols×rows float/u8 field into a dw×dh region of a gw×gh grid
  function resample(src, sw, sh, dst, gw, gh, ox, oy, s, scaleVal) {
    for (let r = 0; r < gh; r++) {
      const y0 = Math.max(0, (r - oy) / s), y1 = Math.min(sh, (r + 1 - oy) / s);
      if (y1 <= y0) continue;
      const ry0 = Math.floor(y0), ry1 = Math.ceil(y1);
      for (let c = 0; c < gw; c++) {
        const x0 = Math.max(0, (c - ox) / s), x1 = Math.min(sw, (c + 1 - ox) / s);
        if (x1 <= x0) continue;
        const rx0 = Math.floor(x0), rx1 = Math.ceil(x1);
        let sum = 0, wsum = 0;
        for (let y = ry0; y < ry1; y++) {
          const wy = Math.min(y + 1, y1) - Math.max(y, y0);
          if (wy <= 0) continue;
          const rowOff = y * sw;
          for (let x = rx0; x < rx1; x++) {
            const wx = Math.min(x + 1, x1) - Math.max(x, x0);
            if (wx <= 0) continue;
            const w = wx * wy;
            sum += src[rowOff + x] * w;
            wsum += w;
          }
        }
        if (wsum > 0) dst[r * gw + c] = (sum / wsum) * scaleVal;
      }
    }
  }

  /* ── scene: globe (LED panel style) ────────────────── */
  PG.scenes.globe = function (opts) {
    const o = Object.assign({
      name: "globe",
      radius: 0.46,     // sphere radius as fraction of min(cols, rows)
      cx: 0.5, cy: 0.5, // sphere center as fraction of cols / rows
      period: 20,       // seconds per revolution (0 or Infinity = still)
      direction: 1,     // 1 = west→east (surface moves left→right)
      tilt: 0,          // axis tilt in degrees (screen plane)
      lon0: 0,          // longitude facing the viewer at t = 0
      land: 1.0, ocean: 0.3,
      edge: 0.35,       // darkening toward the limb: 0 = flat, 1 = black rim
      supersample: 3,   // samples per cell edge (anti-aliased coastlines)
      mask: null        // { w, h, data } — defaults to PixelGrid.assets.landMask
    }, opts);

    let bits = null, MW = 0, MH = 0;
    let cells, sampOff, sampRow, sampLon, cellShade, ncell = 0;

    return {
      name: o.name, dynamic: true, opts: o,
      init(grid) {
        const mask = o.mask || PG.assets.landMask;
        if (!mask) throw new Error("PixelGrid.scenes.globe: no land mask (load scenes/landmask.js)");
        if (bits === null || MW !== mask.w || MH !== mask.h) {
          MW = mask.w; MH = mask.h;
          const packed = toU8(mask.data);
          bits = new Uint8Array(MW * MH);
          for (let i = 0; i < bits.length; i++) bits[i] = (packed[i >> 3] >> (7 - (i & 7))) & 1;
        }
        const cols = grid.cols, rows = grid.rows;
        const R = o.radius * Math.min(cols, rows);
        const cxc = o.cx * cols, cyc = o.cy * rows;
        const S = Math.max(1, o.supersample | 0);
        const th = (o.tilt * Math.PI) / 180, ct = Math.cos(th), st = Math.sin(th);
        const cellsA = [], offA = [], rowA = [], lonA = [], shadeA = [];
        const inv = 1 / (S * S);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const dx = c + 0.5 - cxc, dy = r + 0.5 - cyc;
            if (dx * dx + dy * dy > (R + 1) * (R + 1)) continue;
            let cnt = 0, shade = 0;
            const start = rowA.length;
            for (let sy = 0; sy < S; sy++) {
              for (let sx = 0; sx < S; sx++) {
                const x = (c + (sx + 0.5) / S - cxc) / R;
                const y = (r + (sy + 0.5) / S - cyc) / R;
                const xr = x * ct - y * st, yr = x * st + y * ct;
                const d2 = xr * xr + yr * yr;
                if (d2 > 1) continue;
                const z = Math.sqrt(1 - d2);
                const lat = Math.asin(-yr);
                const lon = Math.atan2(xr, z);
                rowA.push(clamp(Math.floor((0.5 - lat / Math.PI) * MH), 0, MH - 1) * MW);
                lonA.push((lon / TAU + 0.5) * MW);
                shade += 1 - o.edge * (1 - z);
                cnt++;
              }
            }
            if (!cnt) continue;
            cellsA.push(r * cols + c);
            offA.push(start, cnt);
            shadeA.push((shade * inv));
          }
        }
        ncell = cellsA.length;
        cells = Int32Array.from(cellsA);
        sampOff = Int32Array.from(offA);
        sampRow = Int32Array.from(rowA);
        sampLon = Float32Array.from(lonA);
        cellShade = Float32Array.from(shadeA);
      },
      sample(t, out) {
        const per = o.period;
        const spin = per && isFinite(per) ? (t / per) * MW * o.direction : 0;
        const off = (o.lon0 / 360) * MW - spin;
        const land = o.land, ocean = o.ocean;
        for (let i = 0; i < ncell; i++) {
          const s0 = sampOff[i * 2], n = sampOff[i * 2 + 1];
          let sum = 0;
          for (let j = s0; j < s0 + n; j++) {
            let col = (sampLon[j] + off) % MW;
            if (col < 0) col += MW;
            sum += bits[sampRow[j] + (col | 0)] ? land : ocean;
          }
          out[cells[i]] = (sum / n) * cellShade[i];
        }
      }
    };
  };

  /* ── scene: baked image (cols×rows brightness bytes) ── */
  PG.scenes.image = function (opts) {
    const o = Object.assign({
      name: "image",
      cols: 0, rows: 0, data: null, // data: base64 / Uint8Array / number[] of cols*rows bytes, 0..255
      fit: "contain",               // contain | cover | stretch
      scale: 1,                     // extra scale on top of fit
      align: [0.5, 0.5],
      gain: 1, gamma: 1, floor: 0.02,
      motion: null                  // { spinPeriod, swayX, swayY, swayPeriod, zoomAmp, zoomPeriod, sweepPeriod, sweepWidth, sweepGain } cells / seconds
    }, opts);
    const src = toU8(o.data);
    if (o.motion) return imageMotionScene(o, src);
    let cache = null;
    return {
      name: o.name, dynamic: false, opts: o,
      init(grid) {
        const gw = grid.cols, gh = grid.rows, sw = o.cols, sh = o.rows;
        cache = new Float32Array(gw * gh);
        let sx = gw / sw, sy = gh / sh, s;
        if (o.fit === "cover") s = Math.max(sx, sy) * o.scale;
        else if (o.fit === "stretch") s = null;
        else s = Math.min(sx, sy) * o.scale;
        if (s === null) {
          // stretch: resample per axis by mapping through a temporary square-ish pass
          const tmp = new Float32Array(gw * sh);
          resample(src, sw, sh, tmp, gw, sh, 0, 0, gw / sw, 1);
          // tmp is gw×sh; second pass vertical
          const out = cache;
          for (let c = 0; c < gw; c++) {
            for (let r = 0; r < gh; r++) {
              const y0 = (r / gh) * sh, y1 = ((r + 1) / gh) * sh;
              let sum = 0, wsum = 0;
              for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
                const wy = Math.min(y + 1, y1) - Math.max(y, y0);
                if (wy <= 0) continue;
                sum += tmp[y * gw + c] * wy; wsum += wy;
              }
              out[r * gw + c] = wsum ? sum / wsum : 0;
            }
          }
        } else {
          const dw = sw * s, dh = sh * s;
          const ox = (gw - dw) * o.align[0], oy = (gh - dh) * o.align[1];
          resample(src, sw, sh, cache, gw, gh, ox, oy, s, 1);
        }
        for (let i = 0; i < cache.length; i++) {
          let v = cache[i] / 255;
          if (o.gamma !== 1) v = Math.pow(v, o.gamma);
          v *= o.gain;
          cache[i] = v < o.floor ? 0 : clamp(v, 0, 1);
        }
      },
      sample(t, out) { out.set(cache); }
    };
  };

  /* ── scene: offscreen canvas painter ──────────────── */
  // paint(ctx, t, W, H, scene) draws (grayscale, transparent background) into a canvas of
  // cols*S × rows*S px; the result is box-averaged into the cells. Base for text / hands / motion.
  PG.scenes.canvas = function (opts) {
    const o = Object.assign({
      name: "canvas", supersample: 3, paint: null, init: null, gain: 1, gamma: 1, floor: 0.02, dynamic: true,
      spinPeriod: 0,    // seconds per full turn around the vertical axis (0 = no spin)
      spinBack: 0.55,   // brightness of the back side while it faces the viewer
      spinMirror: false,// true = the back side is mirrored like a real card; false = stays readable
      spinMin: 0.06     // thinnest horizontal scale when edge-on
    }, opts);
    let cv = null, ctx = null, W = 0, H = 0, S = 1, cols = 0, rows = 0;
    let base = [1, 0, 0, 1, 0, 0];
    const self = {
      name: o.name, dynamic: o.dynamic !== false, opts: o, canvas: null, ctx: null, cellPx: 1, cols: 0, rows: 0,
      spinCos: 1, spinDim: 1,
      reset(c) { c.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]); },
      init(grid) {
        cols = grid.cols; rows = grid.rows; S = Math.max(1, o.supersample | 0);
        W = cols * S; H = rows * S;
        if (!cv) { cv = document.createElement("canvas"); ctx = cv.getContext("2d", { willReadFrequently: true }); }
        cv.width = W; cv.height = H;
        self.canvas = cv; self.ctx = ctx; self.cellPx = S; self.cols = cols; self.rows = rows; self.W = W; self.H = H;
        self._cache = null;
        if (o.init) o.init(self, grid);
      },
      sample(t, out) {
        if (!self.dynamic && self._cache) { out.set(self._cache); return; }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, W, H);
        const sp = self.opts.spinPeriod;
        if (sp > 0) {
          const th = TAU * t / sp, c = Math.cos(th);
          const sx = (c < 0 && self.opts.spinMirror ? -1 : 1) * Math.max(Math.abs(c), self.opts.spinMin);
          base = [sx, 0, 0, 1, W / 2 - sx * W / 2, 0];
          self.spinCos = c; self.spinDim = c < 0 ? self.opts.spinBack : 1;
        } else { base = [1, 0, 0, 1, 0, 0]; self.spinCos = 1; self.spinDim = 1; }
        self.reset(ctx);
        o.paint(ctx, t, W, H, self);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
        const data = ctx.getImageData(0, 0, W, H).data;
        const inv = self.spinDim / (S * S * 65025);
        const gain = self.opts.gain, gamma = self.opts.gamma, floor = self.opts.floor;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            let sum = 0;
            for (let y = r * S, ye = y + S; y < ye; y++) {
              let p = (y * W + c * S) * 4;
              for (let x = 0; x < S; x++, p += 4) sum += (data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722) * data[p + 3];
            }
            let v = sum * inv;
            if (gamma !== 1) v = Math.pow(v, gamma);
            v *= gain;
            out[r * cols + c] = v < floor ? 0 : v > 1 ? 1 : v;
          }
        }
        if (!self.dynamic) self._cache = Float32Array.from(out);
      }
    };
    return self;
  };

  const gray = (v) => { const g = Math.round(clamp(v, 0, 1) * 255); return "rgb(" + g + "," + g + "," + g + ")"; };
  const fitScale = (fit, sx, sy) => (fit === "cover" ? Math.max(sx, sy) : fit === "stretch" ? null : Math.min(sx, sy));

  // baked image + motion (sway / zoom / light sweep), drawn through the canvas painter
  function imageMotionScene(o, src) {
    let srcCv = null;
    const scene = PG.scenes.canvas(Object.assign({ spinPeriod: o.motion.spinPeriod || 0 }, o, {
      init(self) {
        if (!srcCv) {
          srcCv = document.createElement("canvas"); srcCv.width = o.cols; srcCv.height = o.rows;
          const c2 = srcCv.getContext("2d");
          const im = c2.createImageData(o.cols, o.rows);
          for (let i = 0; i < src.length; i++) { const v = src[i]; im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
          c2.putImageData(im, 0, 0);
        }
      },
      paint(ctx, t, W, H, self) {
        const oo = self.opts, m = oo.motion || {}, S = self.cellPx;
        const sw = oo.cols, sh = oo.rows;
        const tp = m.swayPeriod || 5;
        let s = fitScale(oo.fit, W / sw, H / sh);
        let dw, dh;
        if (s === null) { dw = W; dh = H; } else { s *= oo.scale * (1 + (m.zoomAmp || 0) * Math.sin(TAU * t / (m.zoomPeriod || 7))); dw = sw * s; dh = sh * s; }
        const ox = (W - dw) * oo.align[0] + (m.swayX || 0) * S * Math.sin(TAU * t / tp);
        const oy = (H - dh) * oo.align[1] + (m.swayY || 0) * S * Math.sin(TAU * t / tp * 0.71 + 1.3);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(srcCv, ox, oy, dw, dh);
        if (m.sweepGain > 0) {
          const per = m.sweepPeriod || 4, wd = Math.max(1, (m.sweepWidth || 0.25) * (W + H) * 0.5);
          const pos = ((t / per) % 1) * (W + H + 2 * wd) - wd;
          ctx.globalCompositeOperation = "source-atop";
          ctx.globalAlpha = m.sweepGain;
          self.reset(ctx);
          // band perpendicular to the diagonal: rotate 45°
          ctx.rotate(-Math.PI / 4);
          const g = ctx.createLinearGradient(pos - wd, 0, pos + wd, 0);
          g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g;
          ctx.fillRect(-H - wd, -W, W + H + 2 * wd + H, W * 2 + H * 2);
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
        }
      }
    }));
    return scene;
  }

  /* ── scene: 3D-feel text (extruded, swaying) ──────── */
  PG.FONT = '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Hiragino Sans", "Noto Sans KR", "Noto Sans JP", "Noto Sans CJK KR", system-ui, sans-serif';
  PG.scenes.text = function (opts) {
    const o = Object.assign({
      name: "text", text: "가",
      font: PG.FONT, weight: 800,
      size: 0.62,        // glyph height as a fraction of the grid height
      depth: 2.2,        // extrusion length in cells
      spin: true,        // true = keeps turning a full 360° like the globe; false = sways ±angle
      period: 20,        // seconds per full turn (spin) or per sway cycle
      angle: 32,         // max sway angle (deg) when spin is false
      tilt: 0.35,        // vertical component of the extrusion (0 = pure sideways)
      faceBright: 1, backBright: 0.6, sideBright: 0.45, sideFade: 0.5,
      backMirror: false, // true = the back of the glyph is mirrored; false = stays readable
      maxWidth: 0.92,    // clamp glyph width to this fraction of the grid width
      supersample: 3
    }, opts);
    return PG.scenes.canvas(Object.assign({}, o, { spinPeriod: 0 }, {
      paint(ctx, t, W, H, self) {
        const oo = self.opts, S = self.cellPx;
        const th = oo.spin ? TAU * t / Math.max(0.5, oo.period) : (oo.angle * Math.PI / 180) * Math.sin(TAU * t / oo.period);
        const cosT = Math.cos(th);
        let px = oo.size * H;
        ctx.font = oo.weight + " " + px + "px " + oo.font;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const tw = ctx.measureText(oo.text).width;
        const maxW = oo.maxWidth * W;
        if (tw > maxW) { px *= maxW / tw; ctx.font = oo.weight + " " + px + "px " + oo.font; }
        const cx = W / 2, cy = H / 2 + px * 0.05;
        const sx = (cosT < 0 && oo.backMirror ? -1 : 1) * Math.max(0.08, Math.abs(cosT)); // negative = mirrored back
        const layers = Math.max(0, Math.round(oo.depth * S));
        let ux = -Math.sin(th), uy = oo.tilt;
        const len = Math.hypot(ux, uy) || 1; ux /= len; uy /= len;
        for (let i = layers; i >= 1; i--) {
          const f = i / layers;
          ctx.fillStyle = gray(oo.sideBright * (1 - oo.sideFade * f));
          self.reset(ctx); ctx.translate(cx + ux * i, cy + uy * i); ctx.scale(sx, 1);
          ctx.fillText(oo.text, 0, 0);
        }
        ctx.fillStyle = gray((cosT < 0 ? oo.backBright : oo.faceBright) * (0.72 + 0.28 * Math.abs(cosT)));
        self.reset(ctx); ctx.translate(cx, cy); ctx.scale(sx, 1);
        ctx.fillText(oo.text, 0, 0);
      }
    }));
  };

  /* ── scene: two hands reaching (Creation of Adam) ─── */
  // unit hand space: index fingertip at (0,0), reaching along +x, forearm toward -x.
  PG.scenes.hands = function (opts) {
    const o = Object.assign({
      name: "hands",
      period: 8,        // seconds per approach / touch / retreat cycle
      gap: 1.2,         // fingertip gap at contact, in cells
      reach: 6,         // extra distance when retreated, in cells
      size: 1,          // overall scale (1 = index finger ≈ 15 cells on a 46-cell card)
      spark: 1,         // spark intensity at contact (0 = off)
      human: 0.8,       // brightness of the human hand
      robot: 1,         // brightness of the robot hand plates
      angle: null,      // reach direction in deg (null = along the card diagonal)
      spinPeriod: 20,   // the whole tableau turns around the vertical axis like the globe (0 = off)
      supersample: 3
    }, opts);

    // polyline with tapering thickness (r0 at start → r1 at end)
    function taper(ctx, pts, r0, r1) {
      let total = 0; for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        const L = Math.hypot(bx - ax, by - ay), n = Math.max(2, Math.ceil(L / 0.03));
        for (let k = 0; k <= n; k++) {
          const f = k / n, d = acc + L * f, r = r0 + (r1 - r0) * (d / total);
          ctx.beginPath(); ctx.arc(ax + (bx - ax) * f, ay + (by - ay) * f, r, 0, TAU); ctx.fill();
        }
        acc += L;
      }
    }
    function rpoly(ctx, pts, r) { // polygon with rounded corners
      ctx.lineJoin = "round"; ctx.lineWidth = r * 2;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath();
      ctx.fill(); if (r > 0) ctx.stroke();
    }
    function line(ctx, x0, y0, x1, y1, w, style) { ctx.strokeStyle = style; ctx.lineWidth = w; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }

    /* human hand: relaxed, wrist hanging, soft skin shading, creases, nail */
    function drawHuman(ctx, u, bright) {
      ctx.save(); ctx.scale(u, u);
      const g = ctx.createLinearGradient(-3.8, 0, 0.1, 0);
      g.addColorStop(0, gray(bright * 0.5)); g.addColorStop(0.5, gray(bright * 0.78)); g.addColorStop(1, gray(bright));
      ctx.fillStyle = g; ctx.strokeStyle = g;
      // forearm (elbow thick → wrist thin) with a gentle curve
      taper(ctx, [[-3.9, 1.05], [-2.9, 0.78], [-2.0, 0.5]], 0.34, 0.22);
      // palm (drooping from the wrist)
      rpoly(ctx, [[-2.0, 0.28], [-1.3, 0.0], [-0.66, -0.04], [-0.55, 0.36], [-0.85, 0.66], [-1.75, 0.76]], 0.1);
      // fingers: index extended and slightly drooping, the rest curling in
      taper(ctx, [[-0.66, -0.02], [-0.32, -0.02], [0, 0]], 0.115, 0.08);
      taper(ctx, [[-0.6, 0.16], [-0.3, 0.24], [-0.22, 0.44]], 0.11, 0.075);
      taper(ctx, [[-0.64, 0.34], [-0.38, 0.45], [-0.34, 0.62]], 0.1, 0.07);
      taper(ctx, [[-0.74, 0.5], [-0.56, 0.6], [-0.56, 0.74]], 0.085, 0.06);
      taper(ctx, [[-1.3, 0.1], [-1.0, -0.2], [-0.74, -0.32]], 0.13, 0.09);
      // knuckle highlights and joint creases
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      for (const [x, y, r] of [[-0.68, 0.0, 0.09], [-0.62, 0.17, 0.085], [-0.66, 0.35, 0.08], [-0.76, 0.5, 0.07], [-1.0, -0.2, 0.09]]) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
      const crease = "rgba(0,0,0,0.42)";
      line(ctx, -0.32, -0.12, -0.32, 0.08, 0.035, crease);
      line(ctx, -0.3, 0.14, -0.28, 0.34, 0.035, crease);
      line(ctx, -0.4, 0.36, -0.36, 0.54, 0.03, crease);
      line(ctx, -1.02, -0.3, -0.96, -0.1, 0.03, crease);
      line(ctx, -1.95, 0.32, -1.85, 0.72, 0.03, "rgba(0,0,0,0.25)"); // wrist fold
      // nail on the index fingertip
      ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.beginPath(); ctx.ellipse(-0.07, -0.02, 0.06, 0.04, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }

    /* robot hand: angular plates, segmented fingers with joint pins, seams, cables, glowing core */
    function drawRobot(ctx, u, bright) {
      ctx.save(); ctx.scale(u, u);
      const plate = gray(bright), plateDim = gray(bright * 0.72), seam = "rgba(0,0,0,0.95)";
      const finger = (bx, by, ang, len, th, segs, tipChamfer) => {
        ctx.save(); ctx.translate(bx, by); ctx.rotate(ang);
        const gap = 0.045;
        for (let i = 0; i < segs; i++) {
          const s0 = (i * len) / segs + (i ? gap / 2 : 0), s1 = ((i + 1) * len) / segs - (i < segs - 1 ? gap / 2 : 0);
          ctx.fillStyle = i % 2 ? plateDim : plate;
          ctx.beginPath();
          if (i === segs - 1 && tipChamfer) { const c = th * 0.45; ctx.moveTo(s0, -th / 2); ctx.lineTo(s1 - c, -th / 2); ctx.lineTo(s1, -th / 2 + c); ctx.lineTo(s1, th / 2 - c * 0.6); ctx.lineTo(s1 - c, th / 2); ctx.lineTo(s0, th / 2); }
          else ctx.rect(s0, -th / 2, s1 - s0, th);
          ctx.closePath(); ctx.fill();
          if (i) { // joint pin
            ctx.fillStyle = seam; ctx.beginPath(); ctx.arc(s0 - gap / 2, 0, th * 0.3, 0, TAU); ctx.fill();
            ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(s0 - gap / 2, 0, th * 0.12, 0, TAU); ctx.fill();
          }
        }
        ctx.restore();
      };
      // forearm housing: chamfered box, panel seams, three cables, a bright wrist cuff
      ctx.fillStyle = plate;
      rpoly(ctx, [[-3.9, 0.25], [-2.1, 0.2], [-1.95, 0.28], [-1.95, 0.8], [-2.1, 0.9], [-3.9, 0.95]], 0);
      line(ctx, -3.3, 0.24, -3.3, 0.94, 0.04, seam);
      line(ctx, -2.7, 0.22, -2.7, 0.92, 0.04, seam);
      for (const y of [0.42, 0.56, 0.7]) line(ctx, -3.85, y, -2.75, y, 0.025, "rgba(0,0,0,0.55)");
      ctx.fillStyle = "#fff"; ctx.fillRect(-2.05, 0.16, 0.14, 0.8);
      line(ctx, -1.98, 0.16, -1.98, 0.96, 0.03, seam);
      // palm plate + core
      ctx.fillStyle = plate;
      rpoly(ctx, [[-1.9, 0.08], [-1.15, -0.06], [-0.62, -0.02], [-0.5, 0.42], [-0.86, 0.74], [-1.85, 0.72]], 0.02);
      line(ctx, -1.85, 0.3, -1.25, 0.32, 0.035, seam);
      line(ctx, -1.25, 0.32, -0.6, 0.12, 0.035, seam);
      line(ctx, -1.25, 0.32, -0.9, 0.7, 0.035, seam);
      ctx.fillStyle = seam; ctx.beginPath(); ctx.arc(-1.25, 0.32, 0.2, 0, TAU); ctx.fill();
      const core = ctx.createRadialGradient(-1.25, 0.32, 0, -1.25, 0.32, 0.17);
      core.addColorStop(0, "#fff"); core.addColorStop(0.5, "rgba(255,255,255,0.8)"); core.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = core; ctx.beginPath(); ctx.arc(-1.25, 0.32, 0.17, 0, TAU); ctx.fill();
      // fingers: index straight and pointing, the rest spread a little, thumb angled
      finger(-0.66, 0.0, 0, 0.66, 0.2, 3, true);
      finger(-0.6, 0.2, 0.21, 0.6, 0.19, 3, true);
      finger(-0.62, 0.4, 0.44, 0.52, 0.17, 3, true);
      finger(-0.72, 0.56, 0.68, 0.4, 0.15, 3, true);
      finger(-1.35, 0.08, -0.95, 0.5, 0.2, 2, true);
      ctx.restore();
    }

    return PG.scenes.canvas(Object.assign({}, o, {
      paint(ctx, t, W, H, self) {
        const oo = self.opts, S = self.cellPx;
        const P = Math.max(0.5, oo.period), ph = (t % P) / P;
        // 0..0.42 approach, 0.42..0.72 touch, 0.72..1 retreat
        let d;
        if (ph < 0.42) d = 1 - easeInOutCubic(ph / 0.42);
        else if (ph < 0.72) d = 0;
        else d = easeInOutCubic((ph - 0.72) / 0.28);
        const touching = ph >= 0.42 && ph < 0.72;
        const tremble = touching ? Math.sin(t * 37) * 0.15 : 0;
        const gapPx = (oo.gap + oo.reach * d) * S;
        const ang = oo.angle === null || oo.angle === undefined ? Math.atan2(-H * 0.62, W * 0.9) : (oo.angle * Math.PI / 180);
        const cx = W / 2, cy = H / 2;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        const u = Math.min(W, H) * 0.42 * oo.size; // px per hand unit
        const breathe = Math.sin(t * 0.9) * 0.4 * S;
        // human hand from bottom-left
        ctx.save();
        ctx.translate(cx - dx * gapPx * 0.5 + dy * breathe, cy - dy * gapPx * 0.5 - dx * breathe);
        ctx.rotate(ang);
        drawHuman(ctx, u, oo.human);
        ctx.restore();
        // robot hand from top-right, mirrored across the reach axis
        ctx.save();
        ctx.translate(cx + dx * (gapPx * 0.5 + tremble * S) - dy * breathe * 0.6, cy + dy * (gapPx * 0.5 + tremble * S) + dx * breathe * 0.6);
        ctx.rotate(ang + Math.PI); ctx.scale(1, -1);
        drawRobot(ctx, u, oo.robot);
        ctx.restore();
        // spark at the meeting point
        if (oo.spark > 0 && touching) {
          const k = Math.sin(((ph - 0.42) / 0.3) * Math.PI);
          const r = (1.2 + 1.6 * k) * S;
          ctx.globalCompositeOperation = "lighter";
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.2);
          g.addColorStop(0, "rgba(255,255,255," + (0.95 * oo.spark * k) + ")");
          g.addColorStop(0.35, "rgba(255,255,255," + (0.45 * oo.spark * k) + ")");
          g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 2.2, 0, TAU); ctx.fill();
          const rng = mulberry32(Math.floor(t * 14));
          ctx.strokeStyle = "rgba(255,255,255," + (0.9 * oo.spark * k) + ")"; ctx.lineWidth = Math.max(1, S * 0.35); ctx.lineCap = "round";
          ctx.beginPath();
          const half = gapPx * 0.5 + S * 0.4;
          ctx.moveTo(cx - dx * half, cy - dy * half);
          for (let i = 1; i < 5; i++) { const f = i / 5, j = (rng() - 0.5) * S * 1.6; ctx.lineTo(cx - dx * half + dx * half * 2 * f - dy * j, cy - dy * half + dy * half * 2 * f + dx * j); }
          ctx.lineTo(cx + dx * half, cy + dy * half); ctx.stroke();
          for (let i = 0; i < 6; i++) { const a = t * 0.8 + i * TAU / 6, L = r * (1.4 + rng() * 0.8); ctx.globalAlpha = 0.5 * oo.spark * k; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r * 0.5, cy + Math.sin(a) * r * 0.5); ctx.lineTo(cx + Math.cos(a) * L, cy + Math.sin(a) * L); ctx.stroke(); }
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
        }
      }
    }));
  };

  /* ── scene: 3D light bulb, turning and glowing ────── */
  PG.scenes.bulb = function (opts) {
    const o = Object.assign({
      name: "bulb",
      period: 10,        // seconds per turn around the vertical axis
      pulsePeriod: 2.6,  // glow breathing period (s)
      glow: 1,           // halo strength (0 = off)
      rays: 1,           // light rays strength (0 = off)
      size: 1,           // overall scale
      glass: 0.16,       // glass fill brightness when dim
      turns: 16,         // filament coil turns
      cy: 0.44,          // bulb center height (fraction of the grid height)
      supersample: 3
    }, opts);
    return PG.scenes.canvas(Object.assign({}, o, { spinPeriod: 0 }, {
      paint(ctx, t, W, H, self) {
        const oo = self.opts, S = self.cellPx;
        const th = TAU * t / Math.max(0.5, oo.period), cs = Math.cos(th), sn = Math.sin(th);
        const pulse = 0.7 + 0.3 * Math.sin(TAU * t / Math.max(0.2, oo.pulsePeriod)) + 0.05 * Math.sin(t * 23.7);
        const R = Math.min(W, H) * 0.29 * oo.size;
        const cx = W / 2, cy = H * oo.cy;
        const rot = (x, y, z) => ({ X: cx + (x * cs - z * sn) * R, Y: cy + y * R, Z: x * sn + z * cs });
        const w = (v) => "rgba(255,255,255," + clamp(v, 0, 1).toFixed(3) + ")";

        /* halo + rays, behind everything */
        if (oo.glow > 0 || oo.rays > 0) {
          ctx.globalCompositeOperation = "lighter";
          if (oo.glow > 0) {
            const hg = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * 2.5);
            hg.addColorStop(0, w(0.5 * oo.glow * pulse)); hg.addColorStop(0.35, w(0.16 * oo.glow * pulse)); hg.addColorStop(1, w(0));
            ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(cx, cy, R * 2.5, 0, TAU); ctx.fill();
          }
          if (oo.rays > 0) {
            ctx.lineCap = "round"; ctx.lineWidth = Math.max(1, S * 0.32);
            for (let i = 0; i < 12; i++) {
              const a = th * 0.3 + i * TAU / 12;
              const len = R * (1.35 + 0.4 * Math.sin(t * 1.7 + i * 1.3)) * (0.75 + 0.25 * pulse);
              ctx.strokeStyle = w(0.38 * oo.rays * pulse);
              ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * R * 1.12, cy + Math.sin(a) * R * 1.12); ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); ctx.stroke();
            }
          }
          ctx.globalCompositeOperation = "source-over";
        }

        /* glass envelope: sphere + neck */
        const phi = Math.acos(0.42), neckBot = cy + R * 1.22;
        const glass = () => {
          ctx.beginPath();
          ctx.arc(cx, cy, R, phi, Math.PI - phi, true);
          ctx.lineTo(cx - R * 0.36, neckBot); ctx.lineTo(cx + R * 0.36, neckBot);
          ctx.closePath();
        };
        const fg = ctx.createRadialGradient(cx, cy + R * 0.1, 0, cx, cy + R * 0.1, R * 1.15);
        fg.addColorStop(0, w(oo.glass + 0.26 * pulse)); fg.addColorStop(0.55, w(oo.glass + 0.1 * pulse)); fg.addColorStop(1, w(oo.glass * 0.6));
        glass(); ctx.fillStyle = fg; ctx.fill();
        // rim
        glass(); ctx.strokeStyle = w(0.75); ctx.lineWidth = Math.max(1, S * 0.45); ctx.stroke();
        // specular highlight that travels with the rotation
        const hx = cx + cs * R * 0.42, vis = Math.max(0, cs);
        ctx.fillStyle = w(0.55 * (0.35 + 0.65 * vis));
        ctx.beginPath(); ctx.ellipse(hx, cy - R * 0.45, R * 0.11, R * 0.28, sn * 0.5, 0, TAU); ctx.fill();
        ctx.fillStyle = w(0.25 * (0.35 + 0.65 * Math.max(0, -cs)));
        ctx.beginPath(); ctx.ellipse(cx - cs * R * 0.42, cy - R * 0.3, R * 0.07, R * 0.2, -sn * 0.5, 0, TAU); ctx.fill();

        /* stem + supports (3D, rotate with the bulb) */
        ctx.strokeStyle = w(0.45); ctx.lineWidth = Math.max(1, S * 0.5); ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(cx, neckBot); ctx.lineTo(cx, cy + R * 0.55); ctx.stroke();
        const sup = [[-0.42, 0.14, 0], [0.42, 0.14, 0]].map((p) => rot(p[0], p[1], p[2]));
        ctx.lineWidth = Math.max(1, S * 0.3);
        for (const p of sup) { ctx.strokeStyle = w(0.55 + 0.25 * p.Z); ctx.beginPath(); ctx.moveTo(cx, cy + R * 0.55); ctx.lineTo(p.X, p.Y); ctx.stroke(); }

        /* filament: helix along an arch between the supports */
        const N = Math.max(24, Math.round(oo.turns * 14));
        const pts = [];
        for (let i = 0; i <= N; i++) {
          const sgm = i / N, ph2 = sgm * TAU * oo.turns;
          const ax = -0.42 + 0.84 * sgm, ay = 0.14 - 0.26 * Math.sin(Math.PI * sgm);
          pts.push(rot(ax, ay + 0.065 * Math.cos(ph2), 0.065 * Math.sin(ph2)));
        }
        // glow pass (thick, translucent), then the core with depth cue
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = w(0.3 * pulse); ctx.lineWidth = Math.max(2, S * 1.8);
        ctx.beginPath(); ctx.moveTo(pts[0].X, pts[0].Y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].X, pts[i].Y); ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
        for (let i = 1; i < pts.length; i++) {
          const d = (pts[i].Z + 1) / 2; // 0 far .. 1 near
          ctx.strokeStyle = w((0.55 + 0.45 * d) * (0.75 + 0.25 * pulse)); ctx.lineWidth = Math.max(1, S * (0.22 + 0.2 * d));
          ctx.beginPath(); ctx.moveTo(pts[i - 1].X, pts[i - 1].Y); ctx.lineTo(pts[i].X, pts[i].Y); ctx.stroke();
        }

        /* screw cap: collar, threads with cylinder shading, seam that turns, contact tip */
        const capTop = neckBot, capW = R * 0.44;
        const shade = ctx.createLinearGradient(cx - capW, 0, cx + capW, 0);
        shade.addColorStop(0, w(0.3)); shade.addColorStop(0.35, w(0.85)); shade.addColorStop(0.6, w(0.75)); shade.addColorStop(1, w(0.25));
        ctx.fillStyle = shade;
        ctx.fillRect(cx - capW * 1.1, capTop, capW * 2.2, R * 0.09);                 // collar
        ctx.fillRect(cx - capW, capTop + R * 0.09, capW * 2, R * 0.46);               // screw body
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        for (let i = 0; i < 4; i++) { // thread grooves (slanted like a helix)
          const y = capTop + R * (0.15 + i * 0.11);
          ctx.beginPath(); ctx.moveTo(cx - capW, y + R * 0.03); ctx.lineTo(cx + capW, y - R * 0.03); ctx.lineTo(cx + capW, y - R * 0.005); ctx.lineTo(cx - capW, y + R * 0.055); ctx.closePath(); ctx.fill();
        }
        if (cs > 0) { ctx.fillStyle = "rgba(0,0,0," + (0.45 * cs).toFixed(3) + ")"; ctx.fillRect(cx + sn * capW - Math.max(1, S * 0.15), capTop, Math.max(1, S * 0.3), R * 0.55); }
        ctx.fillStyle = "rgba(0,0,0,0.9)"; ctx.fillRect(cx - capW * 0.7, capTop + R * 0.55, capW * 1.4, R * 0.07); // insulator
        ctx.fillStyle = w(0.8); ctx.beginPath(); ctx.roundRect ? ctx.roundRect(cx - capW * 0.32, capTop + R * 0.6, capW * 0.64, R * 0.11, S) : ctx.rect(cx - capW * 0.32, capTop + R * 0.6, capW * 0.64, R * 0.11); ctx.fill(); // contact tip
      }
    }));
  };

  /* ── scene: custom function ────────────────────────── */
  PG.scenes.custom = function (def) {
    return Object.assign({ name: "custom", dynamic: true, opts: {}, init() {}, sample() {} }, def);
  };

  /* ── grid ──────────────────────────────────────────── */
  const DEFAULTS = {
    designWidth: 0,   // width of the container in design px (390 frame). 0 = use CSS px
    pitch: 4,         // cell pitch (design px when designWidth is set, else CSS px)
    cols: 0,          // explicit column count overrides pitch
    gap: 0.2,         // gap as a fraction of pitch
    radius: 0.2,      // corner radius as a fraction of cell size
    color: "#ffffff",
    background: "",   // "" = transparent
    quantize: 0,      // 0 = continuous, N = brightness levels
    minAlpha: 0.02,   // cells dimmer than this are not drawn
    maxDpr: 2,
    seed: 7,
    flicker: { amp: 0.15, minPeriod: 2, maxPeriod: 4 },
    transition: { duration: 1200, scatter: 0.9, stagger: 0.35, dip: 0.3, out: 0.4 },
    autoCycle: 8000,  // ms between automatic scene changes, 0 = off
    start: 0,
    scenes: [],
    reducedMotion: "auto", // auto | true | false
    autoPause: true
  };
  const NB = 64; // alpha buckets per frame

  class Grid {
    constructor(el, opts) {
      this.el = el;
      this.o = mergeInto(deepCopy(DEFAULTS), opts || {});
      this.scenes = (opts && opts.scenes) ? opts.scenes.slice() : [];
      this.o.scenes = null;
      this.canvas = document.createElement("canvas");
      this.canvas.className = "pixelgrid";
      Object.assign(this.canvas.style, { display: "block", width: "100%", height: "100%" });
      el.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      this.cols = 0; this.rows = 0; this.w = 0; this.h = 0; this.pitchPx = 0; this.dpr = 1; this.offX = 0; this.offY = 0; this.drawn = 0;
      this.cur = clamp(this._index(this.o.start), 0, Math.max(0, this.scenes.length - 1));
      this.nextIdx = -1; this.tr = null;
      this.visible = true; this.paused = false; this.destroyed = false;
      this._t0 = performance.now(); this._pausedTotal = 0; this._pauseStart = 0;
      this._lastSwitch = 0; this._raf = 0; this.fps = 0; this._fpsAcc = 0; this._fpsN = 0; this._fpsT = 0;
      this.onFrame = null;

      this._mq = global.matchMedia ? global.matchMedia("(prefers-reduced-motion: reduce)") : null;
      this._updateReduced();
      if (this._mq && this._mq.addEventListener) this._mq.addEventListener("change", () => this._updateReduced());

      this._layout();
      if (global.ResizeObserver) { this._ro = new ResizeObserver(() => this._layout()); this._ro.observe(el); }
      else global.addEventListener("resize", this._onResize = () => this._layout());
      if (this.o.autoPause) {
        if (global.IntersectionObserver) {
          this._io = new IntersectionObserver((ents) => { this.visible = ents[ents.length - 1].isIntersecting; this._sync(); }, { threshold: 0 });
          this._io.observe(el);
        }
        document.addEventListener("visibilitychange", this._onVis = () => this._sync());
      }
      this._frame = this._frame.bind(this);
      this._sync();
    }

    /* public ------------------------------------------ */
    get scene() { return this.scenes[this.cur]; }
    get transitioning() { return !!this.tr; }
    now() {
      const paused = this._pausedTotal + (this._pauseStart ? performance.now() - this._pauseStart : 0);
      return (performance.now() - this._t0 - paused) / 1000;
    }

    set(patch) {
      const o = this.o;
      const geo = () => JSON.stringify([o.designWidth, o.pitch, o.cols]);
      const rnd = () => JSON.stringify([o.seed, o.flicker.minPeriod, o.flicker.maxPeriod]);
      const g0 = geo(), r0 = rnd();
      mergeInto(o, patch || {});
      if (patch && patch.reducedMotion !== undefined) this._updateReduced();
      if (geo() !== g0) this._layout(true);
      else if (rnd() !== r0 && this._f1) this._randomize();
      if (!this._running) this._render(this.now());
      return this;
    }
    config() { const c = deepCopy(this.o); delete c.scenes; return c; }
    reinit(target) {
      if (!this.cols) return this;
      if (target === undefined) this.scenes.forEach((s) => s.init(this));
      else { const s = this.scenes[this._index(target)]; if (s) s.init(this); }
      if (!this._running) this._render(this.now());
      return this;
    }
    addScene(scene) { this.scenes.push(scene); if (this.cols) scene.init(this); return this; }
    setScenes(list, start) {
      this.scenes = list.slice(); this.cur = clamp(this._index(start || 0), 0, Math.max(0, list.length - 1));
      this.nextIdx = -1; this.tr = null; if (this._offx) { this._offx.fill(0); this._offy.fill(0); }
      if (this.cols) this.scenes.forEach((s) => s.init(this));
      this._lastSwitch = this.now();
      if (!this._running) this._render(this.now());
      return this;
    }

    go(target, instant) {
      const idx = this._index(target);
      if (idx < 0 || idx >= this.scenes.length) return this;
      if (this.tr) { this.cur = this.nextIdx; this.tr = null; }
      if (idx === this.cur) return this;
      const t = this.now();
      this._lastSwitch = t;
      if (instant || this.reduced || this.o.transition.duration <= 0) { this.cur = idx; this._offx.fill(0); this._offy.fill(0); return this; }
      this.nextIdx = idx;
      this.tr = { start: t, dur: this.o.transition.duration / 1000 };
      return this;
    }
    next(instant) { return this.scenes.length ? this.go((this.cur + 1) % this.scenes.length, instant) : this; }
    prev(instant) { return this.scenes.length ? this.go((this.cur - 1 + this.scenes.length) % this.scenes.length, instant) : this; }
    pause() { this.paused = true; this._sync(); return this; }
    resume() { this.paused = false; this._sync(); return this; }
    destroy() {
      this.destroyed = true;
      cancelAnimationFrame(this._raf);
      if (this._ro) this._ro.disconnect();
      if (this._io) this._io.disconnect();
      if (this._onResize) global.removeEventListener("resize", this._onResize);
      if (this._onVis) document.removeEventListener("visibilitychange", this._onVis);
      if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    }

    /* internals ---------------------------------------- */
    _index(t) {
      if (typeof t === "number") return t;
      return this.scenes.findIndex((s) => s.name === t);
    }
    _updateReduced() {
      const rm = this.o.reducedMotion;
      this.reduced = rm === "auto" ? !!(this._mq && this._mq.matches) : !!rm;
    }
    _sync() {
      const shouldRun = !this.destroyed && !this.paused && (!this.o.autoPause || (this.visible && !document.hidden));
      if (shouldRun && !this._running) {
        this._running = true;
        if (this._pauseStart) { this._pausedTotal += performance.now() - this._pauseStart; this._pauseStart = 0; }
        this._raf = requestAnimationFrame(this._frame);
      } else if (!shouldRun && this._running) {
        this._running = false;
        this._pauseStart = performance.now();
        cancelAnimationFrame(this._raf);
      }
    }
    _layout(force) {
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (!w || !h) return;
      const o = this.o;
      let cols = o.cols || (o.designWidth ? Math.round(o.designWidth / o.pitch) : Math.round(w / o.pitch));
      cols = Math.max(1, cols);
      const pitch = w / cols;
      const rows = Math.max(1, Math.round(h / pitch));
      const dpr = Math.min(global.devicePixelRatio || 1, o.maxDpr);
      this.w = w; this.h = h; this.pitchPx = pitch; this.dpr = dpr;
      this.offX = 0; this.offY = (h - rows * pitch) / 2;
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
      if (force || cols !== this.cols || rows !== this.rows) { this.cols = cols; this.rows = rows; this._alloc(); }
      if (!this._running) this._render(this.now());
    }
    _alloc() {
      const n = this.cols * this.rows;
      this._A = new Float32Array(n); this._B = new Float32Array(n); this._out = new Float32Array(n);
      this._offx = new Float32Array(n); this._offy = new Float32Array(n);
      this._f1 = new Float32Array(n); this._p1 = new Float32Array(n);
      this._f2 = new Float32Array(n); this._p2 = new Float32Array(n);
      this._dx = new Float32Array(n); this._dy = new Float32Array(n); this._jit = new Float32Array(n);
      this._order = new Int32Array(n); this._counts = new Int32Array(NB + 1);
      this._randomize();
      this.scenes.forEach((s) => s.init(this));
    }
    _randomize() {
      const n = this.cols * this.rows;
      const rng = mulberry32(this.o.seed);
      const fl = this.o.flicker;
      for (let i = 0; i < n; i++) {
        const per1 = lerp(fl.minPeriod, fl.maxPeriod, rng());
        const per2 = lerp(fl.minPeriod, fl.maxPeriod, rng()) * 0.61;
        this._f1[i] = TAU / per1; this._p1[i] = rng() * TAU;
        this._f2[i] = TAU / per2; this._p2[i] = rng() * TAU;
        const ang = rng() * TAU, mag = 0.5 + rng() * 0.5;
        this._dx[i] = Math.cos(ang) * mag; this._dy[i] = Math.sin(ang) * mag;
        this._jit[i] = rng();
      }
    }
    _frame(ts) {
      if (!this._running) return;
      this._raf = requestAnimationFrame(this._frame);
      if (!this.cols) return; // container had no size yet; ResizeObserver will lay out
      const t = this.now();
      const o = this.o;
      if (o.autoCycle > 0 && this.scenes.length > 1 && !this.tr && t - this._lastSwitch >= o.autoCycle / 1000) this.next();
      this._render(t);
      // fps
      if (this._fpsT) { this._fpsAcc += ts - this._fpsT; this._fpsN++; if (this._fpsAcc >= 500) { this.fps = Math.round(1000 * this._fpsN / this._fpsAcc); this._fpsAcc = 0; this._fpsN = 0; } }
      this._fpsT = ts;
      if (this.onFrame) this.onFrame(this);
    }
    _render(t) {
      if (!this.cols || !this.scenes.length) return;
      this._compute(t);
      this._draw();
    }
    _compute(t) {
      const o = this.o, n = this.cols * this.rows;
      const A = this._A, B = this._B, out = this._out, offx = this._offx, offy = this._offy;
      const tScene = this.reduced ? 0 : t;
      A.fill(0);
      this.scenes[this.cur].sample(tScene, A);
      if (this.tr) {
        B.fill(0);
        this.scenes[this.nextIdx].sample(tScene, B);
        const tr = o.transition;
        const p = clamp((t - this.tr.start) / this.tr.dur, 0, 1);
        const st = clamp(tr.stagger, 0, 0.95), sc = tr.scatter * this.pitchPx, dip = tr.dip, outF = clamp(tr.out, 0.05, 0.95);
        const jit = this._jit, dx = this._dx, dy = this._dy;
        for (let i = 0; i < n; i++) {
          const a = A[i], b = B[i];
          if (a === 0 && b === 0) { out[i] = 0; offx[i] = 0; offy[i] = 0; continue; }
          const q = st > 0 ? clamp((p - jit[i] * st) / (1 - st), 0, 1) : p;
          const bump = q < outF ? easeOutCubic(q / outF) : 1 - easeInOutCubic((q - outF) / (1 - outF));
          out[i] = lerp(a, b, smooth(q)) * (1 - dip * bump);
          offx[i] = dx[i] * sc * bump; offy[i] = dy[i] * sc * bump;
        }
        if (p >= 1) { this.cur = this.nextIdx; this.nextIdx = -1; this.tr = null; offx.fill(0); offy.fill(0); }
      } else {
        out.set(A);
      }
      const amp = this.reduced ? 0 : o.flicker.amp;
      if (amp > 0) {
        const f1 = this._f1, p1 = this._p1, f2 = this._f2, p2 = this._p2;
        for (let i = 0; i < n; i++) {
          const v = out[i];
          if (v <= 0) continue;
          const m = 1 + amp * (0.7 * Math.sin(f1[i] * t + p1[i]) + 0.3 * Math.sin(f2[i] * t + p2[i]));
          out[i] = clamp(v * m, 0, 1);
        }
      }
      const qn = o.quantize | 0;
      if (qn >= 2) for (let i = 0; i < n; i++) { const v = out[i]; if (v > 0) out[i] = Math.ceil(v * qn - 1e-6) / qn; }
    }
    _draw() {
      const ctx = this.ctx, o = this.o, n = this.cols * this.rows;
      const out = this._out, order = this._order, counts = this._counts;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (o.background) { ctx.fillStyle = o.background; ctx.fillRect(0, 0, this.w, this.h); }
      else ctx.clearRect(0, 0, this.w, this.h);
      // counting sort of visible cells into NB alpha buckets (no per-frame allocation)
      counts.fill(0);
      const minA = o.minAlpha;
      for (let i = 0; i < n; i++) { const v = out[i]; if (v < minA) continue; counts[Math.min(NB - 1, (v * NB) | 0) + 1]++; }
      for (let k = 1; k <= NB; k++) counts[k] += counts[k - 1];
      const total = counts[NB];
      const pos = counts.slice(0, NB);
      for (let i = 0; i < n; i++) { const v = out[i]; if (v < minA) continue; order[pos[Math.min(NB - 1, (v * NB) | 0)]++] = i; }

      const pitch = this.pitchPx, cell = pitch * (1 - clamp(o.gap, 0, 0.9)), g2 = (pitch - cell) / 2;
      const rad = Math.min(cell / 2, cell * clamp(o.radius, 0, 0.5));
      const useRound = rad > 0.2 && typeof ctx.roundRect === "function";
      const cols = this.cols, ox = this.offX + g2, oy = this.offY + g2, offx = this._offx, offy = this._offy;
      ctx.fillStyle = o.color;
      for (let k = 0; k < NB; k++) {
        const s = counts[k], e = counts[k + 1];
        if (s === e) continue;
        ctx.globalAlpha = Math.min(1, (k + 1) / NB);
        ctx.beginPath();
        for (let j = s; j < e; j++) {
          const i = order[j];
          const x = ox + (i % cols) * pitch + offx[i];
          const y = oy + ((i / cols) | 0) * pitch + offy[i];
          if (useRound) ctx.roundRect(x, y, cell, cell, rad); else ctx.rect(x, y, cell, cell);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      this.drawn = total;
    }
  }

  PG.mount = (el, opts) => new Grid(el, opts);
  PG.Grid = Grid;
  PG.DEFAULTS = DEFAULTS;
  PG.util = { clamp, lerp, mulberry32, toU8 };
})(typeof window !== "undefined" ? window : globalThis);
