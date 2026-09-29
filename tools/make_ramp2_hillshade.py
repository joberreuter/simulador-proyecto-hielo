"""
Calcula un hillshade (uint8, 255 = sin dato) de extensión completa a partir de
RAMP2_DEM.tif (200 m, EPSG:3031).

Motivo: el RAMP2_HS.tif de Quantarctica3 viene recortado por el oeste
(x >= -2.66e6 m) y deja fuera las Shetland del Sur y el extremo norte de la
Península. El DEM completo llega hasta x = -2.868e6 m.

- Mismo estilo que RAMP2_HS (azimut 315°, altura 45°, z = 1): el hielo plano
  queda en ~180, así que gen_hillshade_tiles.py aplica el mismo realce.
- Máscara de océano: ramp2_dem_osu91a200m.tif == 0 (el DEM elipsoidal tiene
  valores de geoide ~12-20 m sobre el mar, así que no sirve para enmascarar).

Uso (desde simulador/):
    python tools/make_ramp2_hillshade.py [--dir carpeta_RAMP2] [--out hs.tif] [--rows a b]
Reanudable por franjas con --rows (índices de franja de STRIP filas).
Luego:  python tools/gen_hillshade_tiles.py --src hs.tif
"""
import argparse
import math
import os

import numpy as np
import rasterio
from rasterio.windows import Window

DEFAULT_DIR = os.path.expanduser(r"~/Documents/Antarctica/Quantarctica3/Quantarctica3/TerrainModels/RAMP2")
STRIP = 1024
AZ, ALT, Z = 315.0, 45.0, 1.0


def hillshade(dem, cs):
    """dem float32 con 1 fila/col de borde extra en cada lado ya incluida."""
    a = dem[:-2, :-2]; b = dem[:-2, 1:-1]; c = dem[:-2, 2:]
    d = dem[1:-1, :-2];                    f = dem[1:-1, 2:]
    g = dem[2:, :-2];  h = dem[2:, 1:-1];  i = dem[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cs)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cs)
    slope = np.arctan(Z * np.hypot(dzdx, dzdy))
    aspect = np.arctan2(dzdy, -dzdx)
    zen = math.radians(90 - ALT)
    az = math.radians((360 - AZ + 90) % 360)
    hs = 255 * (math.cos(zen) * np.cos(slope) + math.sin(zen) * np.sin(slope) * np.cos(az - aspect))
    return np.clip(hs, 0, 254)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=DEFAULT_DIR)
    ap.add_argument("--out", default="ramp2_hs_full.tif")
    ap.add_argument("--rows", type=int, nargs=2, default=None)
    a = ap.parse_args()

    dem_p = os.path.join(a.dir, "RAMP2_DEM.tif")
    osu_p = os.path.join(a.dir, "ramp2_dem_osu91a200m.tif")
    with rasterio.open(dem_p) as dem, rasterio.open(osu_p) as osu:
        W, H = dem.width, dem.height
        cs = dem.res[0]
        nd = dem.nodata
        if not os.path.exists(a.out):
            prof = dem.profile.copy()
            prof.update(dtype="uint8", nodata=255, compress="deflate", tiled=True,
                        blockxsize=512, blockysize=512, BIGTIFF="IF_SAFER")
            with rasterio.open(a.out, "w", **prof):
                pass
        n = math.ceil(H / STRIP)
        s0, s1 = (0, n) if a.rows is None else (a.rows[0], min(a.rows[1], n))
        with rasterio.open(a.out, "r+") as out:
            for s in range(s0, s1):
                r0 = s * STRIP
                h = min(STRIP, H - r0)
                pr0 = max(0, r0 - 1)
                pr1 = min(H, r0 + h + 1)
                z = dem.read(1, window=Window(0, pr0, W, pr1 - pr0)).astype(np.float32)
                bad = z == nd
                z[bad] = 0
                # rellenar bordes para que el kernel 3x3 no pierda filas/columnas
                top = 1 if pr0 == r0 - 1 else 0
                z = np.pad(z, ((1 - top, 1 - (pr1 - (r0 + h))), (1, 1)), mode="edge")
                hs = hillshade(z, cs)
                land = osu.read(1, window=Window(0, r0, W, h))
                mask = (land > 0) & (land != osu.nodata) & ~bad[top : top + h]
                outv = np.where(mask, np.round(hs), 255).astype(np.uint8)
                out.write(outv, 1, window=Window(0, r0, W, h))
                print(f"franja {s + 1}/{n}", flush=True)


if __name__ == "__main__":
    main()
