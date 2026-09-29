import { lonlat2xy } from "./geo.js";

// Extrae la secuencia de vértices lon/lat de un KML (texto plano).
// Soporta <LineString><coordinates>, <Point><coordinates> (se ignoran,
// no forman línea) y <gx:Track><gx:coord>. Concatena, en orden de
// aparición, todos los bloques de coordenadas encontrados dentro de
// LineString/Track (lo habitual es que un track tenga uno solo).
export function parseKmlToLonLat(kmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(kmlText, "text/xml");

  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    throw new Error("El archivo no es un KML/XML válido.");
  }

  const points = [];

  // <LineString><coordinates>lon,lat,alt lon,lat,alt ...</coordinates>
  const lineStrings = doc.getElementsByTagName("LineString");
  for (const ls of lineStrings) {
    const coordsEl = ls.getElementsByTagName("coordinates")[0];
    if (!coordsEl) continue;
    for (const p of _splitCoordinates(coordsEl.textContent)) points.push(p);
  }

  // Fallback: <gx:Track><gx:coord>lon lat alt</gx:coord>...</gx:Track>
  if (points.length === 0) {
    const coordTags = doc.getElementsByTagName("gx:coord");
    for (const el of coordTags) {
      const parts = el.textContent.trim().split(/\s+/).map(Number);
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        points.push({ lon: parts[0], lat: parts[1] });
      }
    }
  }

  // Último fallback: cualquier <coordinates> suelto (por ejemplo dentro de un Path/Placemark simple).
  if (points.length === 0) {
    const anyCoords = doc.getElementsByTagName("coordinates");
    for (const coordsEl of anyCoords) {
      for (const p of _splitCoordinates(coordsEl.textContent)) points.push(p);
    }
  }

  if (points.length < 2) {
    throw new Error("No se encontraron al menos 2 puntos de coordenadas en el KML.");
  }

  return points;
}

function _splitCoordinates(text) {
  const out = [];
  const tuples = text.trim().split(/\s+/);
  for (const tup of tuples) {
    if (!tup) continue;
    const parts = tup.split(",").map(Number);
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      out.push({ lon: parts[0], lat: parts[1] });
    }
  }
  return out;
}

// Convierte una lista de {lon,lat} a los puntos de track usados por FlightSim
// / MapRenderer: {lon,lat,x,y,d} con d = distancia acumulada en metros.
export function buildTrackPoints(lonLatList) {
  const points = [];
  let d = 0;
  let prev = null;
  for (const { lon, lat } of lonLatList) {
    const [x, y] = lonlat2xy(lon, lat);
    if (prev) d += Math.hypot(x - prev.x, y - prev.y);
    const pt = { lon, lat, x, y, d };
    points.push(pt);
    prev = pt;
  }
  return points;
}
