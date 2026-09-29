"""
Convierte RAMP2_Contours_100m.shp (Quantarctica3, EPSG:3031) al formato binario
que consume js/contours.js:

  data/contours/index.json
  data/contours/coarse.bin          curvas cada 500 m, simplificadas (vista alejada)
  data/contours/t_<i>_<j>.bin       todas las curvas de 100 m, por tiles (vista cercana)

Formato .bin (Float32 LE): originX, originY, nLines, luego por línea:
  elev, nPts, dx0, dy0, dx1, dy1, ...   (coords relativas al origen del archivo)

Uso (desde la carpeta simulador/):
    python tools/gen_contours.py [ruta_shp] [carpeta_salida]
Requiere: numpy, shapely>=2, y geopandas o pyshp.
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

    for elev, pts in iter_lines():
        n_in += 1
        ls = LineString(pts)
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
