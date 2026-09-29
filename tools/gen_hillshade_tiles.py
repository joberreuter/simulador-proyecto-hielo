"""
Genera una pirámide de tiles de hillshade (WebP con transparencia) a partir de
un hillshade RAMP2 de 200 m (EPSG:3031; ver make_ramp2_hillshade.py), para que el fondo del mapa se
vea nítido al acercarse. Lo consume js/hillshade_tiles.js.

Salida:
  data/hs/index.json
  data/hs/<nivel>/<col>_<fila>.webp    tiles de TILE x TILE píxeles

Niveles: 0 = 200 m/px, 1 = 400 m/px, 2 = 800 m/px, 3 = 1600 m/px.
Se aplica un realce de contraste (el hillshade de RAMP2 es muy plano sobre el
hielo) y el océano (sin dato) se pinta gris oscuro opaco como el fondo global; así,
dentro del rectángulo del DEM, se tapan los bordes difusos del fondo de 3 km.

Uso (desde simulador/):
    python tools/gen_hillshade_tiles.py [--src RAMP2_HS.tif] [--out data/hs]
                                        [--levels 0 1 2 3] [--rows a b]
El proceso es reanudable: omite los tiles que ya existen. --rows limita el
rango de filas de tiles a procesar (útil para correrlo por partes).
Requiere: numpy, rasterio, Pillow (con soporte WebP).
"""
import argparse
import json
import os

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import Window

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = "ramp2_hs_full.tif"  # salida de tools/make_ramp2_hillshade.py
DEFAULT_OUT = os.path.join(HERE, "..", "data", "hs")

TILE = 512
N_LEVELS = 4
QUALITY = 72
NODATA = 255

# Realce de contraste alrededor del gris del hielo plano (~180)
CENTER = 180.0
GAIN = 2.0
VMIN, VMAX = 20, 250
OCEAN = 20  # mismo gris que el océano del fondo global (data/global/hillshade.png)


def enhance(a):
    return np.clip(CENTER + (a.astype(np.float32) - CENTER) * GAIN, VMIN, VMAX)


def save_tile(path, val, valid):
    """val (h,w), valid bool (h,w).
    Océano/sin dato dentro del raster -> gris oscuro opaco (OCEAN), igual que el
    fondo global, para tapar los bordes difusos de 3 km del fondo global.
    Fuera del raster (relleno a TILE x TILE en los bordes) -> transparente."""
    h, w = val.shape
    rgba = np.zeros((TILE, TILE, 4), dtype=np.uint8)
    g = np.where(valid, np.round(val), OCEAN).astype(np.uint8)
    rgba[:h, :w, 0] = g
    rgba[:h, :w, 1] = g
    rgba[:h, :w, 2] = g
    rgba[:h, :w, 3] = 255
    Image.fromarray(rgba, "RGBA").save(path, "WEBP", quality=QUALITY, method=4)


def process_level(src, out, lvl, rows=None):
    f = 2**lvl
    W = int(np.ceil(src.width / f))
    H = int(np.ceil(src.height / f))
    n_rows = int(np.ceil(H / TILE))
    n_cols = int(np.ceil(W / TILE))
    d = os.path.join(out, str(lvl))
    os.makedirs(d, exist_ok=True)
    r_from, r_to = (0, n_rows) if rows is None else (rows[0], min(rows[1], n_rows))
    for tr in range(r_from, r_to):
        # ¿Falta algún tile de esta fila? (reanudable)
        y0 = tr * TILE
        h = min(TILE, H - y0)
        src_row0 = y0 * f
        src_h = min(h * f, src.height - src_row0)
        out_h = int(np.ceil(src_h / f))
        strip = src.read(
            1,
            window=Window(0, src_row0, src.width, src_h),
            out_shape=(out_h, W),
            resampling=Resampling.average if f > 1 else Resampling.nearest,
        )
        valid = strip != NODATA
        val = enhance(strip)
        for tc in range(n_cols):
            x0 = tc * TILE
            vm = valid[:, x0 : x0 + TILE]
            # Se escriben también los tiles solo-océano (opacos) para cubrir
            # todo el rectángulo del DEM.
            path = os.path.join(d, f"{tc}_{tr}.webp")
            if os.path.exists(path):
                continue
            save_tile(path, val[:, x0 : x0 + TILE], vm)
        print(f"nivel {lvl}: fila {tr + 1}/{n_rows}", flush=True)
    return n_rows


def write_index(src, out):
    T = src.transform
    index = {
        "source": "RAMP2_HS (Quantarctica3; Liu et al. 2015, NSIDC-0082)",
        "tile": TILE,
        "originX": T.c,
        "originY": T.f,
        "levels": [],
    }
    total = 0
    for lvl in range(N_LEVELS):
        d = os.path.join(out, str(lvl))
        files = sorted(fn for fn in os.listdir(d) if fn.endswith(".webp")) if os.path.isdir(d) else []
        total += sum(os.path.getsize(os.path.join(d, fn)) for fn in files)
        index["levels"].append({"res": T.a * 2**lvl, "tiles": [fn[:-5] for fn in files]})
        print(f"nivel {lvl}: {len(files)} tiles")
    with open(os.path.join(out, "index.json"), "w") as fh:
        json.dump(index, fh)
    print(f"total: {total / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--levels", type=int, nargs="*", default=list(range(N_LEVELS)))
    ap.add_argument("--rows", type=int, nargs=2, default=None)
    ap.add_argument("--index-only", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    with rasterio.open(a.src) as src:
        if not a.index_only:
            for lvl in a.levels:
                process_level(src, a.out, lvl, a.rows)
        write_index(src, a.out)


if __name__ == "__main__":
    main()
