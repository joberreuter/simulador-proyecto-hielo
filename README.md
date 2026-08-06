# Simulador de vuelo — Proyecto Hielo

Simulador 2D de navegación aérea para entrenar al navegante que debe seguir
líneas de vuelo predefinidas comunicándose con el piloto (giros y cambios de
altitud), con delay de reacción simulado (1–5 s), velocidad 350 km/h y
altura objetivo 400 m AGL.

## Contenido
- `index.html`, `style.css`, `js/` — aplicación (HTML/JS/Canvas puro, sin build).
- `data/tracks_index.json` — índice de las 13 líneas de vuelo propuestas (KML → EPSG:3031).
- `data/<track_id>/elev.bin` + `elev.json` — grilla de elevación recortada del MDE
  Bedmap3 (bm3_surface.tif) alrededor de cada track, con buffer de 15 km.
- `data/<track_id>/hillshade.png` — sombreado de relieve para el fondo del mapa.

## Cómo usar
1. Elegir el track en el panel izquierdo → "Cargar track".
2. "Reproducir" inicia el vuelo (avión parte del inicio de la línea, rumbo y
   altitud inicial = terreno + 400 m).
3. Dar órdenes al piloto: grados de giro (izq/der) o cambio de altitud (subir/bajar).
   Cada orden se ejecuta recién después de un delay aleatorio de 1–5 s
   (simulando reacción del piloto en modo manual), y luego el avión gira a
   3°/s y asciende/desciende a 5 m/s hasta el nuevo objetivo.
4. El HUD muestra: tiempo de simulación, coordenadas, rumbo, altitud MSL/AGL
   (en rojo si se aleja >100 m del objetivo de 400 m), distancia recorrida y
   desvío lateral respecto de la línea planificada.
5. Los botones de velocidad (1x–60x) aceleran la simulación para tracks largos.

## Notas sobre los datos
- 6 de los 13 KML son "megarutas" (~5.000 km) que incluyen el traslado desde
  Punta Arenas hasta el sitio de estudio: son horas de vuelo recto antes de
  llegar a la zona de líneas paralelas. Útiles con velocidad de simulación alta.
- 3 archivos (`propuesta02_2horas`, `propuesta02_48min`, `propuesta03_2horas`)
  son tramos ya acotados a la duración real de vuelo (2 h / 48 min a 350 km/h),
  ideales para practicar el seguimiento de líneas con giros.
- El MDE es Bedmap3 surface a 500 m de resolución nativa (EPSG:3031). Se
  recortó y, para los tracks más largos, se remuestreó (factor 3) para
  mantener los archivos livianos (~14 MB en total para las 13 líneas).

## Deploy en Vercel
No requiere build (sitio 100% estático).

```bash
cd simulador
npx vercel deploy --prod
```

O simplemente arrastrar la carpeta `simulador/` en vercel.com → "Add New… →
Project" y seleccionar "Other" como framework (sin build command, output
directory = `.`).

## Próximos pasos sugeridos
- Confirmar cuál de los 13 tracks es el prioritario para el entrenamiento real.
- Ajustar tasa de giro (3°/s) y de ascenso/descenso (5 m/s) si no son
  representativas de la aeronave real.
- Agregar métrica de "score" (desvío lateral RMS) al finalizar el vuelo, si
  se quiere evaluar el desempeño del navegante.
