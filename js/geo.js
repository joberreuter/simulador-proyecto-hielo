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
