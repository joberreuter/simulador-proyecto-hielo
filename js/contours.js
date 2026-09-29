// Capa de curvas de nivel (RAMP2, cada 100 m) como fondo del mapa.
//
// Datos (generados offline desde RAMP2_Contours_100m.shp de Quantarctica):
//   data/contours/index.json  -> { tileSize, detailMaxMpp, coarse:{file}, tiles:{ "i_j": {file, bbox} } }
//   *.bin                     -> Float32 LE: [originX, originY, nLines,
//                                  (elev, nPts, dx0, dy0, dx1, dy1, ...) * nLines]
//                                coords relativas al origen del archivo (precisión float32).
//
// Nivel "coarse": curvas cada 500 m muy simplificadas, para escalas alejadas.
// Nivel "detail": todas las curvas de 100 m, en tiles que se cargan a demanda
// al acercarse (metersPerPixel <= detailMaxMpp).

function parseContourBin(buf) {
  const f = new Float32Array(buf);
  const ox = f[0];
  const oy = f[1];
  const nLines = f[2];
  let k = 3;
  const normal = new Path2D();
  const index = new Path2D(); // curvas maestras (múltiplos de 500 m)
  for (let i = 0; i < nLines; i++) {
    const elev = f[k++];
    const n = f[k++];
    const path = Math.round(elev) % 500 === 0 ? index : normal;
    path.moveTo(f[k], f[k + 1]);
    for (let j = 1; j < n; j++) path.lineTo(f[k + 2 * j], f[k + 2 * j + 1]);
    k += 2 * n;
  }
  return { ox, oy, normal, index };
}

export class ContourLayer {
  constructor(baseUrl = "data/contours/", onUpdate = () => {}) {
    this.baseUrl = baseUrl;
    this.onUpdate = onUpdate;
    this.meta = null;
    this.coarse = null;
    this.tiles = new Map(); // key -> parsed | "loading" | "error"
    this.visible = true;
  }

  async init() {
    this.meta = await fetch(this.baseUrl + "index.json").then((r) => r.json());
    const buf = await fetch(this.baseUrl + this.meta.coarse.file).then((r) => r.arrayBuffer());
    this.coarse = parseContourBin(buf);
    this.onUpdate();
  }

  _requestTile(key) {
    if (this.tiles.has(key)) return;
    const info = this.meta.tiles[key];
    if (!info) return;
    this.tiles.set(key, "loading");
    fetch(this.baseUrl + info.file)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        this.tiles.set(key, parseContourBin(buf));
        this.onUpdate();
      })
      .catch(() => this.tiles.set(key, "error"));
  }

  // Dibuja en el contexto usando la cámara/escala del MapRenderer.
  draw(ctx, renderer, camX, camY) {
    if (!this.visible || !this.meta || !this.coarse) return;
    const mpp = renderer.metersPerPixel;
    const halfW = (renderer.width / 2) * mpp;
    const halfH = (renderer.height / 2) * mpp;
    const view = [camX - halfW, camY - halfH, camX + halfW, camY + halfH];

    const layers = [];
    if (mpp <= this.meta.detailMaxMpp) {
      const ts = this.meta.tileSize;
      const i0 = Math.floor(view[0] / ts);
      const i1 = Math.floor(view[2] / ts);
      const j0 = Math.floor(view[1] / ts);
      const j1 = Math.floor(view[3] / ts);
      let allReady = true;
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = `${i}_${j}`;
          if (!this.meta.tiles[key]) continue;
          const t = this.tiles.get(key);
          if (!t) this._requestTile(key);
          if (t && typeof t === "object") layers.push(t);
          else allReady = false;
        }
      }
      // Mientras cargan los tiles de detalle, mostrar el nivel grueso.
      if (!allReady) layers.unshift(this.coarse);
    } else {
      layers.push(this.coarse);
    }

    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineJoin = "round";
    for (const L of layers) {
      // mundo (relativo al origen del archivo) -> pantalla
      const sx0 = renderer.width / 2 + (L.ox - camX) / mpp;
      const sy0 = renderer.height / 2 - (L.oy - camY) / mpp;
      ctx.setTransform(dpr / mpp, 0, 0, -dpr / mpp, sx0 * dpr, sy0 * dpr);

      ctx.strokeStyle = "rgba(214, 163, 107, 0.45)";
      ctx.lineWidth = 0.8 * mpp;
      ctx.stroke(L.normal);

      ctx.strokeStyle = "rgba(234, 179, 120, 0.85)";
      ctx.lineWidth = 1.4 * mpp;
      ctx.stroke(L.index);
    }
    ctx.restore();
  }
}
