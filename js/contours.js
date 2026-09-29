// Capa de curvas de nivel (RAMP2, cada 100 m) como fondo del mapa.
//
// Datos (generados offline con tools/gen_contours.py desde RAMP2_Contours_100m.shp):
//   data/contours/index.json  -> { tileSize, detailMaxMpp, coarse:{file}, tiles:{ "i_j": {file, bbox} } }
//   *.bin                     -> Float32 LE: [originX, originY, nLines,
//                                  (elev, nPts, dx0, dy0, dx1, dy1, ...) * nLines]
//                                coords relativas al origen del archivo (precisión float32).
//
// Nivel "coarse": curvas cada 500 m muy simplificadas, para escalas alejadas.
// Nivel "detail": todas las curvas de 100 m, en tiles que se cargan a demanda
// al acercarse (metersPerPixel <= detailMaxMpp).
//
// Etiquetas de elevación: en las curvas maestras. Con el nivel de detalle se
// rotulan los múltiplos de 500 m; con el nivel grueso, solo los de 1000 m.

const LABEL_SPACING_PX = 320; // separación deseada entre etiquetas a lo largo de una curva
const LABEL_FONT = "11px -apple-system, 'Segoe UI', Roboto, sans-serif";
const LABEL_BOX_PX = 80; // celda de la grilla anti-solape (px): limita la densidad de etiquetas

// labelStepM: distancia base (m) entre candidatos a etiqueta a lo largo de la curva
function parseContourBin(buf, labelStepM) {
  const f = new Float32Array(buf);
  const ox = f[0];
  const oy = f[1];
  const nLines = f[2];
  let k = 3;
  const normal = new Path2D();
  const index = new Path2D(); // curvas maestras (múltiplos de 500 m)
  const labels = []; // {x, y, ang, elev, rank} en coords de mundo absolutas
  for (let i = 0; i < nLines; i++) {
    const elev = Math.round(f[k++]);
    const n = f[k++];
    const isIndex = elev % 500 === 0;
    const path = isIndex ? index : normal;
    path.moveTo(f[k], f[k + 1]);
    for (let j = 1; j < n; j++) path.lineTo(f[k + 2 * j], f[k + 2 * j + 1]);

    if (isIndex && n >= 2) {
      // Candidatos cada labelStepM, empezando a medio paso para no caer en los extremos.
      let next = labelStepM / 2;
      let acc = 0;
      let rank = 0;
      for (let j = 1; j < n; j++) {
        const x0 = f[k + 2 * (j - 1)];
        const y0 = f[k + 2 * (j - 1) + 1];
        const x1 = f[k + 2 * j];
        const y1 = f[k + 2 * j + 1];
        const seg = Math.hypot(x1 - x0, y1 - y0);
        while (seg > 0 && acc + seg >= next) {
          const t = (next - acc) / seg;
          labels.push({
            x: ox + x0 + t * (x1 - x0),
            y: oy + y0 + t * (y1 - y0),
            ang: Math.atan2(y1 - y0, x1 - x0), // ángulo en mundo (y hacia el norte)
            elev,
            rank: rank++,
          });
          next += labelStepM;
        }
        acc += seg;
      }
    }
    k += 2 * n;
  }
  return { ox, oy, normal, index, labels, labelStepM };
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
    this.coarse = parseContourBin(buf, 40_000);
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
        this.tiles.set(key, parseContourBin(buf, 2_000));
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
    let detail = false;
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
      detail = allReady;
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

    this._drawLabels(ctx, renderer, camX, camY, layers, view, detail ? 500 : 1000);
  }

  _drawLabels(ctx, renderer, camX, camY, layers, view, every) {
    const mpp = renderer.metersPerPixel;
    const W = renderer.width;
    const H = renderer.height;
    const margin = 20 * mpp;
    const occupied = new Set(); // grilla anti-solape en pantalla

    ctx.save();
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(11, 18, 32, 0.85)";
    ctx.fillStyle = "#fcd9a8";

    for (const L of layers) {
      const stride = Math.max(1, Math.round((LABEL_SPACING_PX * mpp) / L.labelStepM));
      for (const lb of L.labels) {
        if (lb.rank % stride !== 0) continue;
        if (lb.elev % every !== 0 || lb.elev <= 0) continue;
        if (lb.x < view[0] + margin || lb.x > view[2] - margin) continue;
        if (lb.y < view[1] + margin || lb.y > view[3] - margin) continue;

        const sx = W / 2 + (lb.x - camX) / mpp;
        const sy = H / 2 - (lb.y - camY) / mpp;
        const cell = `${Math.floor(sx / LABEL_BOX_PX)},${Math.floor(sy / LABEL_BOX_PX)}`;
        if (occupied.has(cell)) continue;
        occupied.add(cell);

        // Ángulo en pantalla (y invertida) y texto siempre legible (no cabeza abajo).
        let a = -lb.ang;
        if (a > Math.PI / 2) a -= Math.PI;
        if (a < -Math.PI / 2) a += Math.PI;

        const text = String(lb.elev);
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr * Math.cos(a), dpr * Math.sin(a), -dpr * Math.sin(a), dpr * Math.cos(a), sx * dpr, sy * dpr);
        ctx.strokeText(text, 0, 0);
        ctx.fillText(text, 0, 0);
      }
    }
    ctx.restore();
  }
}
