// Fondo de hillshade en alta resolución (RAMP2, 200 m) servido como pirámide
// de tiles WebP (ver tools/gen_hillshade_tiles.py). Se elige el nivel según el
// zoom y solo se descargan los tiles visibles. Mientras un tile carga, se ve el
// nivel más grueso ya disponible (o el fondo global de 3 km debajo).

const MAX_CACHE = 400;

export class HillshadeTiles {
  constructor(baseUrl = "data/hs/", onUpdate = () => {}) {
    this.baseUrl = baseUrl;
    this.onUpdate = onUpdate;
    this.meta = null;
    this.levelSets = [];
    this.cache = new Map(); // url -> {img, ok}
  }

  async init() {
    this.meta = await fetch(this.baseUrl + "index.json").then((r) => r.json());
    this.levelSets = this.meta.levels.map((l) => new Set(l.tiles));
    this.onUpdate();
  }

  // Nivel más grueso cuya resolución sigue siendo >= a la de pantalla.
  _targetLevel(mpp) {
    const levels = this.meta.levels;
    let best = 0;
    for (let i = 0; i < levels.length; i++) {
      if (levels[i].res <= mpp * 1.25) best = i;
    }
    return best;
  }

  _get(level, key, request) {
    const url = `${this.baseUrl}${level}/${key}.webp`;
    let e = this.cache.get(url);
    if (!e && request) {
      const img = new Image();
      e = { img, ok: false };
      img.onload = () => {
        e.ok = true;
        this.onUpdate();
      };
      img.onerror = () => {
        e.ok = false;
      };
      img.src = url;
      this.cache.set(url, e);
      if (this.cache.size > MAX_CACHE) {
        // descartar las entradas más antiguas
        const drop = this.cache.size - MAX_CACHE;
        let i = 0;
        for (const k of this.cache.keys()) {
          if (i++ >= drop) break;
          this.cache.delete(k);
        }
      }
    } else if (e) {
      // refrescar posición (LRU simple)
      this.cache.delete(url);
      this.cache.set(url, e);
    }
    return e && e.ok ? e.img : null;
  }

  draw(ctx, renderer, camX, camY) {
    if (!this.meta) return;
    const mpp = renderer.metersPerPixel;
    // Por encima de ~2.4 km/px el fondo global (3 km) es suficiente.
    if (mpp > 2400) return;

    const { tile, originX, originY, levels } = this.meta;
    const halfW = (renderer.width / 2) * mpp;
    const halfH = (renderer.height / 2) * mpp;
    const vx0 = camX - halfW;
    const vx1 = camX + halfW;
    const vy0 = camY - halfH;
    const vy1 = camY + halfH;

    const target = this._targetLevel(mpp);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
    // Primero el nivel inmediatamente más grueso (si ya está en caché) para tapar
    // huecos mientras carga el nivel objetivo; los tiles son opacos.
    const first = Math.min(levels.length - 1, target + 1);
    for (let lvl = first; lvl >= target; lvl--) {
      const span = tile * levels[lvl].res;
      const set = this.levelSets[lvl];
      const c0 = Math.floor((vx0 - originX) / span);
      const c1 = Math.floor((vx1 - originX) / span);
      const r0 = Math.floor((originY - vy1) / span);
      const r1 = Math.floor((originY - vy0) / span);
      const request = lvl === target;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = `${c}_${r}`;
          if (!set.has(key)) continue;
          const img = this._get(lvl, key, request);
          if (!img) continue;
          const wx = originX + c * span;
          const wy = originY - r * span;
          const [sx, sy] = renderer.worldToScreen(wx, wy, camX, camY);
          const size = span / mpp;
          // +0.5 px para evitar costuras finas entre tiles
          ctx.drawImage(img, sx, sy, size + 0.5, size + 0.5);
        }
      }
    }
    ctx.restore();
  }
}
