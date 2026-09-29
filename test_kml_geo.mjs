// Test de regresión para la proyección EPSG:3031 (lonlat2xy) y el formato
// DMS compacto usado por el conversor KML -> TXT (dd2dmsCompact).
// Correr con: node test_kml_geo.mjs
import { dd2dmsCompact, lonlat2xy } from "./js/geo.js";

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`FAIL ${msg}: got ${a} expected ${b}`);
  console.log(`OK ${msg}: ${a}`);
}

assertEq(dd2dmsCompact(-53.0037658597661, true), "530014S", "lat AP01 p0");
assertEq(dd2dmsCompact(-70.8855251077149, false), "0705308W", "lon AP01 p0");

// Acarreo de segundos -> minutos -> grados (10° 59' 59.6" -> 11° 00' 00")
const carrySec = 10 + 59 / 60 + 59.6 / 3600;
assertEq(dd2dmsCompact(carrySec, true), "110000N", "carry sec->min->deg (lat)");

assertEq(dd2dmsCompact(0, true), "000000N", "cero lat");
assertEq(dd2dmsCompact(0, false), "0000000E", "cero lon (grado a 3 digitos)");
assertEq(dd2dmsCompact(-150.5, false), "1503000W", "lon 3 digitos oeste");
assertEq(dd2dmsCompact(150.5, false), "1503000E", "lon 3 digitos este");

console.log("Todos los tests dd2dmsCompact pasaron.");

// Proyección: validado numéricamente contra pyproj/EPSG:3031 al implementarla;
// acá solo se confirma que el módulo real sigue dando el mismo resultado.
const [x, y] = lonlat2xy(-70.8855251077149, -53.0037658597661);
const ex = -3930486.8823847254,
  ey = 1362165.2565812478;
const err = Math.hypot(x - ex, y - ey);
if (err > 0.01) throw new Error(`lonlat2xy error demasiado grande: ${err} m`);
console.log("lonlat2xy OK, error:", err.toFixed(6), "m");
