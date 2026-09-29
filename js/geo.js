// Utilidades geoespaciales: muestreo de elevación, proyección inversa simple, rumbos.

export class ElevationGrid {
  constructor(int16Array, header) {
    this.data = int16Array;
    this.width = header.width;
    this.height = header.height;
    this.transform = header.transform; // [a,b,c,d,e,f] afín: x = a*col + b*row + c ; y = d*col + e*row + f
    this.nodata = header.nodata;
    this.minElev = header.min_elev;
    this.maxElev = header.max_elev;

    // Necesitamos la inversa de la afín para pasar de (x,y) mundo -> (col,row)
    const [a, b, c, d, e, f] = this.transform;
    const det = a * e - b * d;
    this.inv = {
      a: e / det,
      b: -b / det,
      c: (b * f - e * c) / det,
      d: -d / det,
      e: a / det,
      f: (c * d - a * f) / det,
    };
  }

  worldToPixel(x, y) {
    const { a, b, c, d, e, f } = this.inv;
    const col = a * x + b * y + c;
    const row = d * x + e * y + f;
    return [col, row];
  }

  pixelToWorld(col, row) {
    const [a, b, c, d, e, f] = this.transform;
    const x = a * col + b * row + c;
    const y = d * col + e * row + f;
    return [x, y];
  }

  // Elevación bilinear en coordenadas de mundo (EPSG:3031, metros)
  sample(x, y) {
    const [col, row] = this.worldToPixel(x, y);
    const c0 = Math.floor(col);
    const r0 = Math.floor(row);
    const c1 = c0 + 1;
    const r1 = r0 + 1;
    if (c0 < 0 || r0 < 0 || c1 >= this.width || r1 >= this.height) {
      return null;
    }
    const fx = col - c0;
    const fy = row - r0;
    const v00 = this.data[r0 * this.width + c0];
    const v10 = this.data[r0 * this.width + c1];
    const v01 = this.data[r1 * this.width + c0];
    const v11 = this.data[r1 * this.width + c1];
    if ([v00, v10, v01, v11].some((v) => v === this.nodata)) return null;
    const top = v00 * (1 - fx) + v10 * fx;
    const bot = v01 * (1 - fx) + v11 * fx;
    return top * (1 - fy) + bot * fy;
  }
}

// Rumbo (bearing) en grados, 0=N, 90=E, entre dos puntos (x,y proyectados, y=norte)
export function bearing(x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let b = (Math.atan2(dx, dy) * 180) / Math.PI;
  if (b < 0) b += 360;
  return b;
}

export function normalizeAngle(a) {
  a = a % 360;
  if (a < 0) a += 360;
  return a;
}

// Diferencia angular con signo, de "from" a "to", en rango [-180,180]
export function angleDiff(from, to) {
  let d = normalizeAngle(to) - normalizeAngle(from);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export function fmtHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function dd2dms(dd, isLat) {
  const dir = isLat ? (dd >= 0 ? "N" : "S") : dd >= 0 ? "E" : "W";
  const abs = Math.abs(dd);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = ((minFloat - min) * 60).toFixed(1);
  return `${deg}°${String(min).padStart(2, "0")}'${sec}"${dir}`;
}

// Igual que dd2dms pero en formato compacto sin símbolos, para el
// conversor KML -> TXT: DDMMSS + hemisferio (lat, 2 dígitos de grado) o
// DDDMMSS + hemisferio (lon, 3 dígitos de grado). Segundos redondeados
// al entero más cercano, con acarreo hacia minutos/grados si corresponde.
export function dd2dmsCompact(dd, isLat) {
  const dir = isLat ? (dd >= 0 ? "N" : "S") : dd >= 0 ? "E" : "W";
  const abs = Math.abs(dd);
  let deg = Math.floor(abs);
  let minFloat = (abs - deg) * 60;
  let min = Math.floor(minFloat);
  let sec = Math.round((minFloat - min) * 60);
  if (sec >= 60) {
    sec -= 60;
    min += 1;
  }
  if (min >= 60) {
    min -= 60;
    deg += 1;
  }
  const degDigits = isLat ? 2 : 3;
  return `${String(deg).padStart(degDigits, "0")}${String(min).padStart(2, "0")}${String(sec).padStart(2, "0")}${dir}`;
}

// ---- Proyección WGS84 (lon/lat, grados) <-> EPSG:3031 (polar estereográfica
// sur, x/y en metros) ----
// Implementación de Snyder (variante B), verificada numéricamente contra
// pyproj/EPSG:3031 usando los puntos ya proyectados de los tracks existentes
// (error < 1 mm en los casos de prueba).
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const PS_E2 = WGS84_F * (2 - WGS84_F);
const PS_E = Math.sqrt(PS_E2);
const PS_LAT_TS = -71; // paralelo estándar de EPSG:3031
const PS_LON0 = 0;

function _d2r(d) {
  return (d * Math.PI) / 180;
}

function _psT(phi) {
  return (
    Math.tan(Math.PI / 4 - phi / 2) /
    Math.pow((1 - PS_E * Math.sin(phi)) / (1 + PS_E * Math.sin(phi)), PS_E / 2)
  );
}

// lon/lat en grados (WGS84) -> x/y en metros (EPSG:3031)
export function lonlat2xy(lon, lat) {
  const phi = _d2r(-lat);
  const lambda = _d2r(-lon);
  const lambda0 = _d2r(-PS_LON0);
  const phi1 = _d2r(-PS_LAT_TS);

  const t = _psT(phi);
  const t1 = _psT(phi1);
  const m1 = Math.cos(phi1) / Math.sqrt(1 - PS_E2 * Math.sin(phi1) ** 2);
  const rho = WGS84_A * m1 * (t / t1);
  const xp = rho * Math.sin(lambda - lambda0);
  const yp = -rho * Math.cos(lambda - lambda0);
  return [-xp, -yp];
}
