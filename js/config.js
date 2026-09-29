// Versión de los datos en data/. Vercel sirve data/ con caché "immutable" de
// 1 año (vercel.json), así que el navegador NUNCA vuelve a pedir un archivo con
// la misma URL. Cada vez que se regeneren o reemplacen archivos en data/
// (tiles, curvas, índices, tracks), SUBIR este número para forzar la descarga.
export const DATA_VERSION = 3;

// Agrega ?v=DATA_VERSION a una ruta de datos.
export function v(url) {
  return `${url}${url.includes("?") ? "&" : "?"}v=${DATA_VERSION}`;
}
