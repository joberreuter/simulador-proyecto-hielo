import { ElevationGrid, fmtHMS, dd2dms, dd2dmsCompact, bearing, angleDiff } from "./geo.js";
import { FlightSim } from "./sim.js";
import { MapRenderer } from "./render.js";
import { parseKmlToLonLat, buildTrackPoints } from "./kml.js";
import { ContourLayer } from "./contours.js";
import { HillshadeTiles } from "./hillshade_tiles.js";

const NM_PER_M = 1 / 1852;
const ZOOM_MIN_MPP = 10;
const ZOOM_MAX_MPP = 15000;
const ZOOM_SLIDER_MAX = 1000;

// "3858.5 km / 2083.4 mn"
function fmtKmNm(km) {
  return `${Number(km).toFixed(1)} km / ${((km * 1000) * NM_PER_M).toFixed(1)} mn`;
}

function sliderToMpp(v) {
  return ZOOM_MIN_MPP * Math.pow(ZOOM_MAX_MPP / ZOOM_MIN_MPP, v / ZOOM_SLIDER_MAX);
}
function mppToSlider(mpp) {
  return (ZOOM_SLIDER_MAX * Math.log(mpp / ZOOM_MIN_MPP)) / Math.log(ZOOM_MAX_MPP / ZOOM_MIN_MPP);
}

const els = {
  trackSelect: document.getElementById("trackSelect"),
  speedKmh: document.getElementById("speedKmh"),
  loadBtn: document.getElementById("loadBtn"),
  playBtn: document.getElementById("playBtn"),
  resetBtn: document.getElementById("resetBtn"),
  speedSelect: document.getElementById("speedSelect"),
  zoomRange: document.getElementById("zoomRange"),
  zoomLabel: document.getElementById("zoomLabel"),
  nudgeSeconds: document.getElementById("nudgeSeconds"),
  rewindBtn: document.getElementById("rewindBtn"),
  ffBtn: document.getElementById("ffBtn"),
  turnDeg: document.getElementById("turnDeg"),
  turnLeftBtn: document.getElementById("turnLeftBtn"),
  turnRightBtn: document.getElementById("turnRightBtn"),
  armedTurnIndicator: document.getElementById("armedTurnIndicator"),
  dropPointBtn: document.getElementById("dropPointBtn"),
  altDelta: document.getElementById("altDelta"),
  climbBtn: document.getElementById("climbBtn"),
  descendBtn: document.getElementById("descendBtn"),
  pendingList: document.getElementById("pendingList"),
  logList: document.getElementById("logList"),
  canvas: document.getElementById("mapCanvas"),
  measureDistBtn: document.getElementById("measureDistBtn"),
  measureAngleBtn: document.getElementById("measureAngleBtn"),
  measureHint: document.getElementById("measureHint"),
  measDistRow: document.getElementById("measDistRow"),
  measBearingRow: document.getElementById("measBearingRow"),
  measAngleRow: document.getElementById("measAngleRow"),
  measDist: document.getElementById("measDist"),
  measBearing: document.getElementById("measBearing"),
  measAngle: document.getElementById("measAngle"),
  hudTime: document.getElementById("hudTime"),
  hudCoords: document.getElementById("hudCoords"),
  hudHeading: document.getElementById("hudHeading"),
  hudSpeed: document.getElementById("hudSpeed"),
  hudAltMsl: document.getElementById("hudAltMsl"),
  hudAgl: document.getElementById("hudAgl"),
  hudDist: document.getElementById("hudDist"),
  hudCrossTrack: document.getElementById("hudCrossTrack"),
  hudTrackName: document.getElementById("hudTrackName"),
  status: document.getElementById("status"),
  centerBtn: document.getElementById("centerBtn"),
  kmlFileInput: document.getElementById("kmlFileInput"),
  kmlLoadStatus: document.getElementById("kmlLoadStatus"),
  kmlConvertInput: document.getElementById("kmlConvertInput"),
  kmlConvertBtn: document.getElementById("kmlConvertBtn"),
  kmlConvertStatus: document.getElementById("kmlConvertStatus"),
  contoursToggle: document.getElementById("contoursToggle"),
};

// Curvas de nivel RAMP2 (100 m). Se carga una vez y se comparte entre
// renderers; al llegar tiles de detalle se redibuja el cuadro.
const contourLayer = new ContourLayer("data/contours/", () => drawFrame());

// Hillshade RAMP2 200 m en tiles (fondo nítido al acercarse).
const hsTiles = new HillshadeTiles("data/hs/", () => drawFrame());

let sim = null;
let renderer = null;
let playing = false;
let speedMult = 1;
let lastTs = null;
let tracksIndex = null;

// Track cargado por el usuario desde un KML local (no viene del índice
// precargado). Se guarda aquí y se referencia con el id especial "custom".
let customTrackMeta = null;

// Puntos lon/lat leídos del KML elegido en el conversor (panel aparte,
// independiente del track cargado en el simulador).
let convertKmlLonLat = null;

// Giro preparado por el navegante, pendiente de transmitir al piloto
let armedTurn = null; // {direction:'left'|'right', degrees:number}

// Herramienta de medición: 'distance' | 'angle' | null
let activeMeasureTool = null;

// Regla (2 puntos, 1 línea)
let measureDragging = false;
let measureStart = null; // [x,y] mundo
let measureEnd = null; // [x,y] mundo

// Transportador (3 puntos: vértice, extremo rayo 1, extremo rayo 2)
let anglePoints = []; // hasta 3 puntos [x,y] finalizados
let anglePreview = null; // punto tentativo mientras se ubica el próximo

// Cámara: por defecto sigue al avión. Al arrastrar el mapa se desacopla
// y queda fija en el punto manual hasta que se pulsa "Centrar".
let followAircraft = true;
let manualCam = { x: 0, y: 0 };
let panDragging = false;
let panLastScreen = null;

function getCamera() {
  return followAircraft ? { x: sim.pos.x, y: sim.pos.y } : manualCam;
}

// Fondo de todo el continente (baja resolución), se carga una sola vez
// y se reasigna a cada MapRenderer nuevo al cambiar de track.
let globalBg = null; // {img, header}

async function loadGlobalBackground() {
  if (globalBg) return globalBg;
  const header = await fetch("data/global/header.json").then((r) => r.json());
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = "data/global/hillshade.png";
  });
  globalBg = { img, header };
  return globalBg;
}

// Grilla de elevación de todo el continente, baja resolución (3 km/píxel).
// Se usa como terreno para tracks personalizados cargados desde un KML,
// que no tienen un recorte de alta resolución precalculado.
let globalElevGrid = null;

async function loadGlobalElevationGrid() {
  if (globalElevGrid) return globalElevGrid;
  const [header, bin] = await Promise.all([
    fetch("data/global/header.json").then((r) => r.json()),
    fetch("data/global/elev.bin").then((r) => r.arrayBuffer()),
  ]);
  globalElevGrid = new ElevationGrid(new Int16Array(bin), header);
  return globalElevGrid;
}

async function loadTracksIndex() {
  const res = await fetch("data/tracks_index.json");
  tracksIndex = await res.json();
  const ids = Object.keys(tracksIndex).sort();
  els.trackSelect.innerHTML = ids
    .map((id) => {
      const t = tracksIndex[id];
      return `<option value="${id}">${t.name} (${fmtKmNm(t.length_km)})</option>`;
    })
    .join("");
}

async function loadTrack(id) {
  els.status.textContent = "Cargando datos del track...";
  const meta = id === "custom" ? customTrackMeta : tracksIndex[id];
  if (!meta) return;

  let elevGrid, hillshadeImg;
  if (meta.custom) {
    // Track cargado desde un KML local: sin recorte de alta resolución
    // precalculado, se usa el terreno de todo el continente (3 km/píxel).
    elevGrid = await loadGlobalElevationGrid();
    hillshadeImg = null;
  } else {
    const [headerRes, binRes] = await Promise.all([
      fetch(meta.elev_header).then((r) => r.json()),
      fetch(meta.dem).then((r) => r.arrayBuffer()),
    ]);
    const int16 = new Int16Array(binRes);
    elevGrid = new ElevationGrid(int16, headerRes);

    hillshadeImg = new Image();
    await new Promise((resolve, reject) => {
      hillshadeImg.onload = resolve;
      hillshadeImg.onerror = reject;
      hillshadeImg.src = meta.hillshade;
    });
  }

  sim = new FlightSim(meta.points, elevGrid, {
    speedKmh: Number(els.speedKmh.value) || 350,
    targetAgl: 400,
    turnRateDegS: 3,
    climbRateMs: 5,
    pilotDelayRange: [1, 5],
  });

  renderer = new MapRenderer(els.canvas, elevGrid, hillshadeImg, meta.points);
  renderer.resize();
  const bg = await loadGlobalBackground();
  renderer.setGlobalBackground(bg.img, bg.header);
  renderer.setContours(contourLayer);
  renderer.setHillshadeTiles(hsTiles);
  applyZoom(sliderToMpp(Number(els.zoomRange.value)));

  els.hudTrackName.textContent = meta.custom
    ? `${meta.name} — ${fmtKmNm(meta.length_km)} — ${meta.n_points} pts (KML, terreno baja res.)`
    : `${meta.name} — ${fmtKmNm(meta.length_km)} — ${meta.n_points} pts`;
  els.status.textContent = `Listo. Duración estimada de vuelo: ${fmtHMS(sim.estFlightTimeSec())}`;
  playing = false;
  els.playBtn.textContent = "▶ Reproducir";
  clearArmedTurn();
  clearAllMeasurements();
  setFollowAircraft(true);
  updatePendingList();
  updateLog();
  drawFrame();
}

function updatePendingList() {
  const pending = sim.pendingCommands();
  if (pending.length === 0) {
    els.pendingList.innerHTML = '<div class="muted">Sin órdenes pendientes</div>';
    return;
  }
  els.pendingList.innerHTML = pending
    .map((c) => {
      const eta = Math.max(0, c.execTime - sim.simTime).toFixed(1);
      if (c.kind === "turn") {
        return `<div>🛩 Girar ${c.direction === "left" ? "izquierda" : "derecha"} ${c.degrees}° — piloto en ${eta}s</div>`;
      }
      return `<div>🛩 ${c.delta >= 0 ? "Ascender" : "Descender"} ${Math.abs(c.delta)} m — piloto en ${eta}s</div>`;
    })
    .join("");
}

function updateLog() {
  const log = sim.executedLog.slice(-8).reverse();
  if (log.length === 0) {
    els.logList.innerHTML = '<div class="muted">Sin órdenes ejecutadas aún</div>';
    return;
  }
  els.logList.innerHTML = log
    .map((c) => {
      const t = fmtHMS(c.actualExecTime);
      if (c.kind === "turn") {
        return `<div>[${t}] Giro ${c.direction === "left" ? "izq." : "der."} ${c.degrees}° ejecutado</div>`;
      }
      return `<div>[${t}] ${c.delta >= 0 ? "Ascenso" : "Descenso"} ${Math.abs(c.delta)} m ejecutado</div>`;
    })
    .join("");
}

function updateHud() {
  const { lon, lat } = sim.currentLonLat();
  els.hudTime.textContent = fmtHMS(sim.simTime);
  els.hudCoords.textContent = `${dd2dms(lat, true)}  ${dd2dms(lon, false)}`;
  els.hudHeading.textContent = `${sim.heading.toFixed(0)}°`;
  els.hudSpeed.textContent = `${(sim.speedMs * 3.6).toFixed(0)} km/h`;
  els.hudAltMsl.textContent = `${sim.altitudeMsl.toFixed(0)} m`;
  const agl = sim.agl();
  const overSea = !sim.hasTerrainData();
  els.hudAgl.textContent = `${agl.toFixed(0)} m${overSea ? " (ref. nivel del mar)" : ""}`;
  els.hudAgl.style.color = Math.abs(agl - sim.targetAgl) > 100 ? "#f87171" : overSea ? "#94a3b8" : "#4ade80";
  els.hudDist.textContent = `${(sim.distanceFlown / 1000).toFixed(1)} / ${sim.totalLengthKm().toFixed(1)} km`;
  els.hudCrossTrack.textContent = `${sim.crossTrack.toFixed(0)} m`;
}

function drawFrame() {
  if (!renderer || !sim) return;
  const cam = getCamera();
  renderer.draw(cam.x, cam.y, { x: sim.pos.x, y: sim.pos.y, heading: sim.heading }, sim.flownPath);

  if (activeMeasureTool === "distance" && measureStart && measureEnd) {
    renderer.drawMeasurement(cam.x, cam.y, measureStart, measureEnd);
  }
  if (activeMeasureTool === "angle" && anglePoints.length > 0) {
    const vertex = anglePoints[0];
    const ray1 = anglePoints[1] ?? (anglePoints.length === 1 ? anglePreview : null);
    const ray2 = anglePoints[2] ?? (anglePoints.length === 2 ? anglePreview : null);
    renderer.drawAngleTool(cam.x, cam.y, vertex, [ray1, ray2]);
  }

  updateHud();
}

// ---- Cámara: seguir avión / paneo manual / centrar ----
function setFollowAircraft(value) {
  followAircraft = value;
  els.centerBtn.classList.toggle("following", followAircraft);
}

function startPan(sx, sy) {
  manualCam = getCamera(); // capturar el punto de vista actual antes de desacoplar
  followAircraft = false;
  els.centerBtn.classList.remove("following");
  panDragging = true;
  panLastScreen = { sx, sy };
  els.canvas.classList.add("panning");
}

els.centerBtn.addEventListener("click", () => {
  setFollowAircraft(true);
  drawFrame();
});

function tick(ts) {
  if (playing && sim) {
    if (lastTs === null) lastTs = ts;
    const dtReal = (ts - lastTs) / 1000;
    lastTs = ts;
    const dtSim = Math.min(dtReal * speedMult, 2 * speedMult); // evitar saltos grandes
    sim.step(dtSim);
    updatePendingList();
    updateLog();
    if (sim.finished) {
      playing = false;
      els.playBtn.textContent = "▶ Reproducir";
      els.status.textContent = "Vuelo finalizado.";
    }
  } else {
    lastTs = ts;
  }
  drawFrame();
  requestAnimationFrame(tick);
}

// ---- Zoom (escala logarítmica + presets + rueda del mouse) ----
function applyZoom(mpp) {
  if (!renderer) return;
  renderer.setZoom(mpp);
  els.zoomRange.value = String(Math.round(mppToSlider(renderer.metersPerPixel)));
  const widthKm = (renderer.width * renderer.metersPerPixel) / 1000;
  els.zoomLabel.textContent = `${renderer.metersPerPixel.toFixed(0)} m/píxel (~${widthKm.toFixed(1)} km de ancho visible)`;
}

els.zoomRange.addEventListener("input", () => {
  applyZoom(sliderToMpp(Number(els.zoomRange.value)));
  drawFrame();
});
els.canvas.addEventListener(
  "wheel",
  (evt) => {
    if (!renderer) return;
    evt.preventDefault();
    const factor = evt.deltaY > 0 ? 1.15 : 1 / 1.15;
    applyZoom(renderer.metersPerPixel * factor);
    drawFrame();
  },
  { passive: false }
);

// ---- Preparar / transmitir giro ----
function armTurn(direction, degrees) {
  armedTurn = { direction, degrees };
  els.armedTurnIndicator.textContent = `Preparado: ${direction === "left" ? "izquierda" : "derecha"} ${degrees}° — pulsa "En el punto de caída" para transmitir`;
  els.dropPointBtn.disabled = false;
}

function clearArmedTurn() {
  armedTurn = null;
  els.armedTurnIndicator.textContent = "Sin giro preparado";
  els.dropPointBtn.disabled = true;
}

// ---- Medición: regla (distancia) ----
function clearDistanceMeasurement() {
  measureStart = null;
  measureEnd = null;
  measureDragging = false;
  els.measDist.textContent = "—";
  els.measBearing.textContent = "—";
}

function updateDistanceReadout() {
  if (!measureStart || !measureEnd) return;
  const dx = measureEnd[0] - measureStart[0];
  const dy = measureEnd[1] - measureStart[1];
  const distM = Math.hypot(dx, dy);
  els.measDist.textContent = `${(distM / 1000).toFixed(2)} km / ${(distM * NM_PER_M).toFixed(2)} mn`;
  const brg = bearing(measureStart[0], measureStart[1], measureEnd[0], measureEnd[1]);
  els.measBearing.textContent = `${brg.toFixed(1)}°`;
}

// ---- Medición: transportador (ángulo, 3 puntos / 2 rayos) ----
function clearAngleMeasurement() {
  anglePoints = [];
  anglePreview = null;
  els.measAngle.textContent = "—";
}

function updateAngleReadout() {
  const vertex = anglePoints[0];
  const ray1 = anglePoints[1] ?? (anglePoints.length === 1 ? anglePreview : null);
  const ray2 = anglePoints[2] ?? (anglePoints.length === 2 ? anglePreview : null);
  if (!vertex || !ray1 || !ray2) {
    els.measAngle.textContent = "—";
    return;
  }
  const b1 = bearing(vertex[0], vertex[1], ray1[0], ray1[1]);
  const b2 = bearing(vertex[0], vertex[1], ray2[0], ray2[1]);
  const diff = angleDiff(b1, b2);
  const dir = diff >= 0 ? "derecha" : "izquierda";
  els.measAngle.textContent = `${Math.abs(diff).toFixed(1)}° (${dir}) — rayo 1: ${b1.toFixed(1)}°, rayo 2: ${b2.toFixed(1)}°`;
}

function clearAllMeasurements() {
  clearDistanceMeasurement();
  clearAngleMeasurement();
}

function setActiveMeasureTool(tool) {
  if (activeMeasureTool === tool) {
    // volver a apretar el mismo botón desactiva la herramienta
    activeMeasureTool = null;
  } else {
    activeMeasureTool = tool;
  }
  clearAllMeasurements();

  els.measureDistBtn.classList.toggle("active", activeMeasureTool === "distance");
  els.measureAngleBtn.classList.toggle("active", activeMeasureTool === "angle");
  els.measDistRow.style.display = activeMeasureTool === "distance" ? "" : "none";
  els.measBearingRow.style.display = activeMeasureTool === "distance" ? "" : "none";
  els.measAngleRow.style.display = activeMeasureTool === "angle" ? "" : "none";

  if (activeMeasureTool === "distance") {
    els.measureHint.textContent = "Mantén presionado y arrastra sobre el mapa para trazar la línea";
  } else if (activeMeasureTool === "angle") {
    els.measureHint.textContent = "Haz clic: 1) vértice, 2) primer rayo, 3) segundo rayo";
  } else {
    els.measureHint.textContent = "Elige una herramienta";
  }
  drawFrame();
}

function canvasEventToWorld(evt) {
  const rect = els.canvas.getBoundingClientRect();
  const sx = evt.clientX - rect.left;
  const sy = evt.clientY - rect.top;
  const cam = getCamera();
  return renderer.screenToWorld(sx, sy, cam.x, cam.y);
}

els.canvas.addEventListener("mousedown", (evt) => {
  if (!sim || !renderer) return;
  if (activeMeasureTool === "distance") {
    measureDragging = true;
    measureStart = canvasEventToWorld(evt);
    measureEnd = measureStart;
    updateDistanceReadout();
    drawFrame();
  } else if (activeMeasureTool === "angle") {
    const pt = canvasEventToWorld(evt);
    if (anglePoints.length >= 3) {
      anglePoints = [pt]; // reinicia una nueva medición
    } else {
      anglePoints.push(pt);
    }
    anglePreview = null;
    updateAngleReadout();
    drawFrame();
  } else {
    // Sin herramienta de medición activa: arrastrar el mapa libremente.
    const rect = els.canvas.getBoundingClientRect();
    startPan(evt.clientX - rect.left, evt.clientY - rect.top);
  }
});
els.canvas.addEventListener("mousemove", (evt) => {
  if (!sim || !renderer) return;
  if (activeMeasureTool === "distance" && measureDragging) {
    measureEnd = canvasEventToWorld(evt);
    updateDistanceReadout();
    drawFrame();
  } else if (activeMeasureTool === "angle" && anglePoints.length > 0 && anglePoints.length < 3) {
    anglePreview = canvasEventToWorld(evt);
    updateAngleReadout();
    drawFrame();
  } else if (panDragging) {
    const rect = els.canvas.getBoundingClientRect();
    const sx = evt.clientX - rect.left;
    const sy = evt.clientY - rect.top;
    const dsx = sx - panLastScreen.sx;
    const dsy = sy - panLastScreen.sy;
    manualCam.x -= dsx * renderer.metersPerPixel;
    manualCam.y += dsy * renderer.metersPerPixel;
    panLastScreen = { sx, sy };
    drawFrame();
  }
});
window.addEventListener("mouseup", () => {
  measureDragging = false;
  panDragging = false;
  els.canvas.classList.remove("panning");
});

els.measureDistBtn.addEventListener("click", () => setActiveMeasureTool("distance"));
els.measureAngleBtn.addEventListener("click", () => setActiveMeasureTool("angle"));

els.loadBtn.addEventListener("click", () => loadTrack(els.trackSelect.value));
els.playBtn.addEventListener("click", () => {
  if (!sim) return;
  playing = !playing;
  lastTs = null;
  els.playBtn.textContent = playing ? "⏸ Pausar" : "▶ Reproducir";
});
els.resetBtn.addEventListener("click", () => {
  if (!sim) return;
  sim.reset();
  playing = false;
  els.playBtn.textContent = "▶ Reproducir";
  clearArmedTurn();
  setFollowAircraft(true);
  updatePendingList();
  updateLog();
  drawFrame();
});
els.speedSelect.addEventListener("change", () => {
  speedMult = Number(els.speedSelect.value);
});

// ---- Adelantar / retroceder manteniendo el rumbo actual ----
els.rewindBtn.addEventListener("click", () => {
  if (!sim) return;
  const secs = Number(els.nudgeSeconds.value) || 30;
  sim.nudge(-secs);
  updatePendingList();
  drawFrame();
});
els.ffBtn.addEventListener("click", () => {
  if (!sim) return;
  const secs = Number(els.nudgeSeconds.value) || 30;
  sim.nudge(secs);
  updatePendingList();
  drawFrame();
});

// ---- Preparar giro (no ejecuta) / transmitir en el punto de caída ----
els.turnLeftBtn.addEventListener("click", () => {
  if (!sim) return;
  armTurn("left", Number(els.turnDeg.value) || 30);
});
els.turnRightBtn.addEventListener("click", () => {
  if (!sim) return;
  armTurn("right", Number(els.turnDeg.value) || 30);
});
els.dropPointBtn.addEventListener("click", () => {
  if (!sim || !armedTurn) return;
  sim.commandTurn(armedTurn.direction, armedTurn.degrees);
  clearArmedTurn();
  updatePendingList();
});

els.climbBtn.addEventListener("click", () => {
  if (!sim) return;
  sim.commandAltitude(Number(els.altDelta.value) || 100);
  updatePendingList();
});
els.descendBtn.addEventListener("click", () => {
  if (!sim) return;
  sim.commandAltitude(-(Number(els.altDelta.value) || 100));
  updatePendingList();
});
window.addEventListener("resize", () => {
  if (renderer) {
    renderer.resize();
    drawFrame();
  }
});

// ---- Capa de curvas de nivel ----
els.contoursToggle.addEventListener("change", () => {
  contourLayer.visible = els.contoursToggle.checked;
  drawFrame();
});

// ---- Cargar track KML desde disco ----
els.kmlFileInput.addEventListener("change", async () => {
  const file = els.kmlFileInput.files[0];
  if (!file) return;
  els.kmlLoadStatus.textContent = "Leyendo KML...";
  try {
    const text = await file.text();
    const lonlat = parseKmlToLonLat(text);
    const points = buildTrackPoints(lonlat);
    const lengthKm = points[points.length - 1].d / 1000;
    customTrackMeta = {
      name: file.name.replace(/\.kml$/i, ""),
      points,
      length_km: Number(lengthKm.toFixed(1)),
      n_points: points.length,
      custom: true,
    };

    let opt = els.trackSelect.querySelector('option[value="custom"]');
    if (!opt) {
      opt = document.createElement("option");
      opt.value = "custom";
      els.trackSelect.appendChild(opt);
    }
    opt.textContent = `📂 ${customTrackMeta.name} (${fmtKmNm(customTrackMeta.length_km)}, personalizado)`;
    els.trackSelect.value = "custom";
    els.kmlLoadStatus.textContent = `Listo: ${customTrackMeta.n_points} puntos, ${fmtKmNm(customTrackMeta.length_km)}. Pulsa "Cargar track" (usa terreno de baja resolución, 3 km/píxel).`;
  } catch (err) {
    console.error(err);
    els.kmlLoadStatus.textContent = `⚠ Error al leer el KML: ${err.message}`;
  }
});

// ---- Conversor KML -> TXT (pares de coordenadas DMS compactas) ----
els.kmlConvertInput.addEventListener("change", async () => {
  const file = els.kmlConvertInput.files[0];
  convertKmlLonLat = null;
  els.kmlConvertBtn.disabled = true;
  if (!file) return;
  els.kmlConvertStatus.textContent = "Leyendo KML...";
  try {
    const text = await file.text();
    convertKmlLonLat = parseKmlToLonLat(text);
    els.kmlConvertStatus.textContent = `Listo: ${convertKmlLonLat.length} puntos.`;
    els.kmlConvertBtn.disabled = false;
  } catch (err) {
    console.error(err);
    els.kmlConvertStatus.textContent = `⚠ Error al leer el KML: ${err.message}`;
  }
});

els.kmlConvertBtn.addEventListener("click", () => {
  if (!convertKmlLonLat) return;
  const line = convertKmlLonLat
    .map((p) => dd2dmsCompact(p.lat, true) + dd2dmsCompact(p.lon, false))
    .join("\r\n") + "\r\n"; // un punto por línea (CRLF para Bloc de notas en Windows)
  const blob = new Blob([line], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const baseName = els.kmlConvertInput.files[0].name.replace(/\.kml$/i, "");
  a.href = url;
  a.download = `${baseName}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

(async function init() {
  try {
    els.status.textContent = "Cargando índice de tracks...";
    await loadTracksIndex();
    await loadTrack(els.trackSelect.value);
    requestAnimationFrame(tick);
    // No bloquea el arranque: si falla, el simulador sigue sin curvas.
    contourLayer.init().catch((err) => console.warn("Curvas de nivel no disponibles:", err));
    hsTiles.init().catch((err) => console.warn("Hillshade de alta resolución no disponible:", err));
  } catch (err) {
    console.error(err);
    const isFileProtocol = location.protocol === "file:";
    els.status.innerHTML = isFileProtocol
      ? `⚠ No se pudieron cargar los datos. Este simulador usa fetch() para leer archivos JSON/binarios, lo cual el navegador bloquea cuando se abre el archivo directamente (file://). Sirve la carpeta con un servidor local, por ejemplo:<br><code>npx serve .</code> o <code>python3 -m http.server 8000</code><br>y abre <code>http://localhost:...</code>, o despliégalo en Vercel.`
      : `⚠ Error al cargar los datos: ${err.message}`;
  }
})();
