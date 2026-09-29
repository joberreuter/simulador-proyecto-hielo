export class MapRenderer {
  constructor(canvas, elevGrid, hillshadeImg, points) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.elevGrid = elevGrid;
    this.hillshadeImg = hillshadeImg;
    this.points = points;
    this.metersPerPixel = 400; // escala inicial: ~400 m/px

    // Fondo opcional de todo el raster (baja resolución), independiente
    // del recorte detallado del track. Se setea una sola vez con setGlobalBackground.
    this.globalImg = null;
    this.globalCorners = null; // [x0,y0,x1,y1] en mundo

    // Capa opcional de curvas de nivel (ContourLayer), sobre el hillshade.
    this.contours = null;
  }

  setContours(layer) {
    this.contours = layer;
  }

  // Registra la imagen de fondo de todo el continente (baja resolución),
  // que se dibuja debajo del hillshade detallado del track, para dar
  // contexto al panear/alejar más allá de la zona recortada.
  setGlobalBackground(img, header) {
    const [a, b, c, d, e, f] = header.transform;
    const x0 = a * 0 + b * 0 + c;
    const y0 = d * 0 + e * 0 + f;
    const x1 = a * header.width + b * header.height + c;
    const y1 = d * header.width + e * header.height + f;
    this.globalImg = img;
    this.globalCorners = [x0, y0, x1, y1];
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
  }

  setZoom(metersPerPixel) {
    this.metersPerPixel = Math.max(10, Math.min(15000, metersPerPixel));
  }

  worldToScreen(x, y, camX, camY) {
    const sx = this.width / 2 + (x - camX) / this.metersPerPixel;
    const sy = this.height / 2 - (y - camY) / this.metersPerPixel;
    return [sx, sy];
  }

  screenToWorld(sx, sy, camX, camY) {
    const x = camX + (sx - this.width / 2) * this.metersPerPixel;
    const y = camY - (sy - this.height / 2) * this.metersPerPixel;
    return [x, y];
  }

  draw(camX, camY, aircraft, flownPath) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, this.width, this.height);

    this._drawGlobalBackground(camX, camY);
    this._drawHillshade(camX, camY);
    if (this.contours) this.contours.draw(ctx, this, camX, camY);
    this._drawTrack(camX, camY);
    this._drawFlownPath(camX, camY, flownPath);
    if (aircraft) this._drawHeadingProjection(camX, camY, aircraft);
    if (aircraft) this._drawAircraft(camX, camY, aircraft);
    this._drawScaleBar();
    this._drawNorthArrow();
  }

  // Línea continua y delgada del recorrido ya realizado por la aeronave
  // (distinta de la línea planificada, que es punteada celeste).
  _drawFlownPath(camX, camY, flownPath) {
    if (!flownPath || flownPath.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    flownPath.forEach((p, i) => {
      const [sx, sy] = this.worldToScreen(p.x, p.y, camX, camY);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.restore();
  }

  // Rayo desde el avión en la dirección del rumbo actual, para comparar
  // visualmente contra la línea planificada (cuánto nos estamos desviando).
  _drawHeadingProjection(camX, camY, aircraft) {
    const ctx = this.ctx;
    // Suficientemente largo para llegar siempre al borde visible, sea cual sea el zoom.
    const lengthM = Math.hypot(this.width, this.height) * this.metersPerPixel * 1.2;
    const rad = (aircraft.heading * Math.PI) / 180;
    const ex = aircraft.x + Math.sin(rad) * lengthM;
    const ey = aircraft.y + Math.cos(rad) * lengthM;
    const [sx0, sy0] = this.worldToScreen(aircraft.x, aircraft.y, camX, camY);
    const [sx1, sy1] = this.worldToScreen(ex, ey, camX, camY);
    ctx.save();
    ctx.strokeStyle = "#fb923c";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(sx0, sy0);
    ctx.lineTo(sx1, sy1);
    ctx.stroke();
    ctx.restore();
  }

  // Dibuja la línea de la herramienta de distancia (regla, 2 puntos).
  // a y b son puntos en coordenadas de mundo [x,y].
  drawMeasurement(camX, camY, a, b) {
    if (!a || !b) return;
    const ctx = this.ctx;
    const [ax, ay] = this.worldToScreen(a[0], a[1], camX, camY);
    const [bx, by] = this.worldToScreen(b[0], b[1], camX, camY);
    ctx.save();
    ctx.strokeStyle = "#facc15";
    ctx.fillStyle = "#facc15";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ax, ay, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx, by, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Dibuja la herramienta de ángulo (transportador): un vértice y hasta
  // dos rayos hacia otros puntos, con un arco indicando el ángulo entre ellos.
  // vertex y cada elemento de rayEnds son puntos de mundo [x,y] o null.
  drawAngleTool(camX, camY, vertex, rayEnds) {
    if (!vertex) return;
    const ctx = this.ctx;
    const [vx, vy] = this.worldToScreen(vertex[0], vertex[1], camX, camY);
    ctx.save();
    ctx.strokeStyle = "#f472b6";
    ctx.fillStyle = "#f472b6";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(vx, vy, 4, 0, Math.PI * 2);
    ctx.fill();

    const screenEnds = [];
    for (const p of rayEnds) {
      if (!p) continue;
      const [ex, ey] = this.worldToScreen(p[0], p[1], camX, camY);
      screenEnds.push([ex, ey]);
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex, ey, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    if (screenEnds.length === 2) {
      const a1 = Math.atan2(screenEnds[0][1] - vy, screenEnds[0][0] - vx);
      const a2 = Math.atan2(screenEnds[1][1] - vy, screenEnds[1][0] - vx);
      ctx.beginPath();
      ctx.strokeStyle = "#f9a8d4";
      ctx.lineWidth = 1.5;
      ctx.arc(vx, vy, 28, a1, a2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Fondo de todo el continente, baja resolución, para dar contexto
  // fuera del área recortada del track (por ejemplo al panear libremente).
  _drawGlobalBackground(camX, camY) {
    if (!this.globalImg || !this.globalCorners) return;
    const [x0, y0, x1, y1] = this.globalCorners;
    const [sx0, sy0] = this.worldToScreen(x0, y0, camX, camY);
    const [sx1, sy1] = this.worldToScreen(x1, y1, camX, camY);
    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
    ctx.drawImage(
      this.globalImg,
      Math.min(sx0, sx1),
      Math.min(sy0, sy1),
      Math.abs(sx1 - sx0),
      Math.abs(sy1 - sy0)
    );
    ctx.restore();
  }

  _drawHillshade(camX, camY) {
    if (!this.hillshadeImg || !this.elevGrid) return;
    const eg = this.elevGrid;
    // Esquinas del raster en mundo -> pantalla
    const [x0, y0] = eg.pixelToWorld(0, 0);
    const [x1, y1] = eg.pixelToWorld(eg.width, eg.height);
    const [sx0, sy0] = this.worldToScreen(x0, y0, camX, camY);
    const [sx1, sy1] = this.worldToScreen(x1, y1, camX, camY);
    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
    ctx.drawImage(
      this.hillshadeImg,
      Math.min(sx0, sx1),
      Math.min(sy0, sy1),
      Math.abs(sx1 - sx0),
      Math.abs(sy1 - sy0)
    );
    ctx.restore();
  }

  _drawTrack(camX, camY) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    this.points.forEach((p, i) => {
      const [sx, sy] = this.worldToScreen(p.x, p.y, camX, camY);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.restore();

    // Marcar inicio/fin
    const start = this.points[0];
    const end = this.points[this.points.length - 1];
    const [ssx, ssy] = this.worldToScreen(start.x, start.y, camX, camY);
    const [esx, esy] = this.worldToScreen(end.x, end.y, camX, camY);
    ctx.fillStyle = "#4ade80";
    ctx.beginPath();
    ctx.arc(ssx, ssy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f87171";
    ctx.beginPath();
    ctx.arc(esx, esy, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawAircraft(camX, camY, aircraft) {
    const ctx = this.ctx;
    const [sx, sy] = this.worldToScreen(aircraft.x, aircraft.y, camX, camY);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate((aircraft.heading * Math.PI) / 180);
    ctx.fillStyle = "#fbbf24";
    ctx.strokeStyle = "#78350f";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8, 10);
    ctx.lineTo(0, 6);
    ctx.lineTo(-8, 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  _drawScaleBar() {
    const ctx = this.ctx;
    const targetPx = 120;
    const meters = targetPx * this.metersPerPixel;
    const niceMeters = this._niceNumber(meters);
    const px = niceMeters / this.metersPerPixel;
    const x0 = 20;
    const y0 = this.height - 24;
    ctx.save();
    ctx.strokeStyle = "#e5e7eb";
    ctx.fillStyle = "#e5e7eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + px, y0);
    ctx.moveTo(x0, y0 - 5);
    ctx.lineTo(x0, y0 + 5);
    ctx.moveTo(x0 + px, y0 - 5);
    ctx.lineTo(x0 + px, y0 + 5);
    ctx.stroke();
    ctx.font = "12px sans-serif";
    const label = niceMeters >= 1000 ? `${niceMeters / 1000} km` : `${niceMeters} m`;
    ctx.fillText(label, x0, y0 - 8);
    ctx.restore();
  }

  _niceNumber(x) {
    const exp = Math.floor(Math.log10(x));
    const base = x / 10 ** exp;
    let nice;
    if (base < 1.5) nice = 1;
    else if (base < 3.5) nice = 2;
    else if (base < 7.5) nice = 5;
    else nice = 10;
    return nice * 10 ** exp;
  }

  _drawNorthArrow() {
    const ctx = this.ctx;
    const x = this.width - 34;
    const y = 44;
    ctx.save();
    ctx.strokeStyle = "#e5e7eb";
    ctx.fillStyle = "#e5e7eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y + 20);
    ctx.lineTo(x, y - 20);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - 24);
    ctx.lineTo(x - 6, y - 14);
    ctx.lineTo(x + 6, y - 14);
    ctx.closePath();
    ctx.fill();
    ctx.font = "bold 12px sans-serif";
    ctx.fillText("N", x - 4, y - 26);
    ctx.restore();
  }
}
