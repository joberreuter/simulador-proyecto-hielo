"""
Convierte RAMP2_Contours_100m.shp (Quantarctica3, EPSG:3031) al formato binario
que consume js/contours.js:

  data/contours/index.json
  data/contours/coarse.bin          curvas cada 500 m, simplificadas (vista alejada)
  data/contours/t_<i>_<j>.bin       todas las curvas de 100 m, por tiles (vista cercana)

Formato .bin (Float32 LE): originX, originY, nLines, luego por línea:
  elev, nPts, dx0, dy0, dx1, dy1, ...   (coords relativas al origen del archivo)

El shapefile de Quantarctica3 viene recortado por el oeste (x >= -2.657e6 m) y
deja fuera las Shetland del Sur y el extremo norte de la Península. Si se indica
la carpeta RAMP2 (con RAMP2_DEM.tif y ramp2_dem_osu91a200m.tif), esa franja
oeste se completa con curvas calculadas del mismo DEM (RAMP2_DEM, elipsoidal,
que es la referencia de Contour_m), con el océano enmascarado vía osu91a == 0.

Uso (desde la carpeta simulador/):
    python tools/gen_contours.py [ruta_shp] [carpeta_salida] [carpeta_RAMP2]
Requiere: numpy, shapely>=2, geopandas o pyshp; para la franja oeste además
rasterio y contourpy.
"""
import json
import math
import os
import sys
from collections import defaultdict

import numpy as np
from shapely import clip_by_rect, simplify
from shapely.geometry import LineString

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SHP = os.path.expanduser(
    r"~/Documents/Antarctica/Quantarctica3/Quantarctica3/TerrainModels/RAMP2/RAMP2_Contours_100m.shp"
)
DEFAULT_OUT = os.path.join(HERE, "..", "data", "contours")

SHP = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SHP
OUT = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
RAMP2_DIR = sys.argv[3] if len(sys.argv) > 3 else os.path.dirname(SHP)

TILE = 250_000.0          # m, lado del tile de detalle
DETAIL_TOL = 60.0         # m, simplificación nivel detalle (< resolución RAMP2 de 200 m)
COARSE_TOL = 2_000.0      # m, simplificación nivel grueso
COARSE_STEP = 500         # m, intervalo de curvas en el nivel grueso
DETAIL_MAX_MPP = 1200     # m/px: por debajo se usan los tiles de detalle
MIN_LEN_DETAIL = 400.0    # m, descartar fragmentos muy cortos
MIN_LEN_COARSE = 8_000.0

ELEV_CANDIDATES = ("contour_m", "elev", "elevation", "contour", "height", "z", "value", "elev_m")


def iter_lines():
    """Devuelve (elev, [(x,y),...]) por cada parte de cada polilínea."""
    try:
        import geopandas as gpd

        gdf = gpd.read_file(SHP)
        print("CRS:", gdf.crs, "| campos:", list(gdf.columns))
        ef = next((c for c in gdf.columns if c.lower() in ELEV_CANDIDATES), None)
        if ef is None:
            raise SystemExit(f"No encontré campo de elevación en {list(gdf.columns)}")
        print("campo elevación:", ef)
        for elev, geom in zip(gdf[ef].astype(float), gdf.geometry):
            if geom is None or geom.is_empty:
                continue
            for g in getattr(geom, "geoms", [geom]):
                if len(g.coords) >= 2:
                    yield elev, [(c[0], c[1]) for c in g.coords]
    except ImportError:
        import shapefile  # pyshp

        r = shapefile.Reader(SHP)
        fields = [f[0] for f in r.fields[1:]]
        print("campos:", fields)
        ef = next((f for f in fields if f.lower() in ELEV_CANDIDATES), None)
        if ef is None:
            raise SystemExit(f"No encontré campo de elevación en {fields}")
        ei = fields.index(ef)
        for sr in r.iterShapeRecords():
            elev = float(sr.record[ei])
            pts = sr.shape.points
            parts = list(sr.shape.parts) + [len(pts)]
            for a, b in zip(parts[:-1], parts[1:]):
                if b - a >= 2:
                    yield elev, pts[a:b]


def iter_dem_lines(xmax):
    """Curvas cada 100 m calculadas de RAMP2_DEM para x < xmax (franja oeste)."""
    dem_p = os.path.join(RAMP2_DIR, "RAMP2_DEM.tif")
    osu_p = os.path.join(RAMP2_DIR, "ramp2_dem_osu91a200m.tif")
    if not (os.path.exists(dem_p) and os.path.exists(osu_p)):
        print("(sin RAMP2_DEM/osu91a: no se completa la franja oeste)")
        return
    import contourpy
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(dem_p) as dem, rasterio.open(osu_p) as osu:
        T = dem.transform
        ncol = int(math.ceil((xmax - T.c) / T.a)) + 1  # +1 col para empalmar
        win = Window(0, 0, ncol, dem.height)
        z = dem.read(1, window=win).astype(np.float64)
        land = osu.read(1, window=win)
        z[(z == dem.nodata) | (land <= 0) | (land == osu.nodata)] = np.nan
        if np.all(np.isnan(z)):
            return
        levels = np.arange(100, np.nanmax(z) + 100, 100)
        # coordenadas de centro de píxel
        xs = T.c + (np.arange(ncol) + 0.5) * T.a
        ys = T.f + (np.arange(dem.height) + 0.5) * T.e
        gen = contourpy.contour_generator(xs, ys, z, line_type="Separate")
        n = 0
        for lv in levels:
            for seg in gen.lines(lv):
                if len(seg) >= 2:
                    n += 1
                    yield float(lv), seg[:, :2]
        print(f"franja oeste (x < {xmax:.0f}): {n} curvas desde RAMP2_DEM")


def write_bin(path, lines, origin):
    ox, oy = origin
    chunks = [np.array([ox, oy, len(lines)], dtype="<f4")]
    for elev, coords in lines:
        c = np.asarray(coords, dtype=np.float64)[:, :2]
        rel = c - np.array([ox, oy])
        chunks.append(np.array([elev, len(c)], dtype="<f4"))
        chunks.append(rel.astype("<f4").ravel())
    data = np.concatenate(chunks)
    data.tofile(path)
    return data.nbytes


def main():
    os.makedirs(OUT, exist_ok=True)
    coarse_lines = []
    tile_lines = defaultdict(list)
    n_in = 0

    shp_minx = [math.inf]

    def all_lines():
        for elev, pts in iter_lines():
            shp_minx[0] = min(shp_minx[0], min(p[0] for p in pts))
            yield elev, pts
        yield from iter_dem_lines(shp_minx[0])

    for elev, pts in all_lines():
        n_in += 1
        ls = LineString(pts)
        if not ls.is_valid or ls.is_empty:
            continue
        if ls.length < MIN_LEN_DETAIL:
            continue

        if int(round(elev)) % COARSE_STEP == 0 and ls.length >= MIN_LEN_COARSE:
            s = simplify(ls, COARSE_TOL, preserve_topology=False)
            if s.length >= MIN_LEN_COARSE and len(s.coords) >= 2:
                coarse_lines.append((elev, list(s.coords)))

        s = simplify(ls, DETAIL_TOL, preserve_topology=False)
        minx, miny, maxx, maxy = s.bounds
        for i in range(math.floor(minx / TILE), math.floor(maxx / TILE) + 1):
            for j in range(math.floor(miny / TILE), math.floor(maxy / TILE) + 1):
                x0, y0 = i * TILE, j * TILE
                part = clip_by_rect(s, x0, y0, x0 + TILE, y0 + TILE)
                if part.is_empty:
                    continue
                for g in getattr(part, "geoms", [part]):
                    if g.geom_type == "LineString" and len(g.coords) >= 2:
                        tile_lines[(i, j)].append((elev, list(g.coords)))

    print("líneas leídas:", n_in, "| coarse:", len(coarse_lines))

    index = {
        "source": "RAMP2_Contours_100m (Quantarctica3; Liu et al. 2015, NSIDC-0082)",
        "interval": 100,
        "tileSize": TILE,
        "detailMaxMpp": DETAIL_MAX_MPP,
        "coarse": {"file": "coarse.bin", "step": COARSE_STEP},
        "tiles": {},
    }
    total = write_bin(os.path.join(OUT, "coarse.bin"), coarse_lines, (0.0, 0.0))
    print(f"coarse.bin: {total/1e6:.2f} MB")

    for (i, j), lines in sorted(tile_lines.items()):
        fname = f"t_{i}_{j}.bin"
        total += write_bin(os.path.join(OUT, fname), lines, (i * TILE, j * TILE))
        index["tiles"][f"{i}_{j}"] = {
            "file": fname,
            "bbox": [i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE],
            "n": len(lines),
        }

    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump(index, f)

    print("tiles:", len(index["tiles"]), "| total MB:", round(total / 1e6, 2))


if __name__ == "__main__":
    main()
