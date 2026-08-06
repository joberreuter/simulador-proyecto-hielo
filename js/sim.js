import { bearing, normalizeAngle } from "./geo.js";

const KMH_TO_MS = 1000 / 3600;

// Punto más cercano sobre una polilínea (para desviación lateral / cross-track)
function nearestOnPolyline(points, x, y) {
  let best = { dist: Infinity, x: points[0].x, y: points[0].y, segIndex: 0, along: points[0].d };
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((x - p0.x) * dx + (y - p0.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = p0.x + t * dx;
    const py = p0.y + t * dy;
    const dist = Math.hypot(x - px, y - py);
    if (dist < best.dist) {
      best = { dist, x: px, y: py, segIndex: i, along: p0.d + t * (p1.d - p0.d) };
    }
  }
  return best;
}

export class FlightSim {
  /**
   * @param {Array} points  puntos del track [{x,y,lon,lat,d}]
   * @param {ElevationGrid} elevGrid
   * @param {Object} opts
   */
  constructor(points, elevGrid, opts = {}) {
    this.points = points;
    this.elevGrid = elevGrid;
    this.speedMs = (opts.speedKmh ?? 350) * KMH_TO_MS;
    this.targetAgl = opts.targetAgl ?? 400; // metros sobre el terreno
    this.turnRateDegS = opts.turnRateDegS ?? 3; // tasa de giro estándar
    this.climbRateMs = opts.climbRateMs ?? 5; // m/s de ascenso/descenso
    this.pilotDelayRange = opts.pilotDelayRange ?? [1, 5]; // segundos

    this.reset();
  }

  reset() {
    const p0 = this.points[0];
    const p1 = this.points[1] ?? this.points[0];
    this.simTime = 0;
    this.pos = { x: p0.x, y: p0.y };
    this.heading = bearing(p0.x, p0.y, p1.x, p1.y);
    const terrain0 = this.elevGrid.sample(p0.x, p0.y) ?? 0;

    // Por defecto el avión sigue el terreno y mantiene siempre esta
    // altura AGL (400 m). Las órdenes de subir/bajar cambian este objetivo.
    this.targetAglCurrent = this.targetAgl;
    this.altitudeMsl = terrain0 + this.targetAglCurrent;

    // Estado del giro en curso (perfil suave, ver _startTurn/step)
    this.turnActive = false;
    this.turnStartHeading = this.heading;
    this.turnTotalAngle = 0; // grados, con signo (+ derecha, - izquierda)
    this.turnStartTime = 0;
    this.turnDuration = 0;
    this.targetAltitudeMsl = this.altitudeMsl;

    this.commandQueue = []; // {id, kind, value, issueTime, execTime, executed}
    this.executedLog = [];
    this._cmdId = 0;

    this.crossTrack = 0;
    this.terrainElev = terrain0;
    this.distanceFlown = 0;
    this.finished = false;

    // Historial del recorrido real de la aeronave (para dibujar su trazo).
    // Solo se agrega un punto nuevo si nos alejamos lo suficiente del último,
    // para no acumular miles de puntos redundantes en vuelos largos.
    this.flownPath = [{ x: p0.x, y: p0.y }];
    this._flownPathMinStepM = 60;
  }

  _recordFlownPoint() {
    const last = this.flownPath[this.flownPath.length - 1];
    if (!last || Math.hypot(this.pos.x - last.x, this.pos.y - last.y) >= this._flownPathMinStepM) {
      this.flownPath.push({ x: this.pos.x, y: this.pos.y });
    }
  }

  totalLengthKm() {
    return this.points[this.points.length - 1].d / 1000;
  }

  estFlightTimeSec() {
    return this.points[this.points.length - 1].d / this.speedMs;
  }

  // Ordenar un giro relativo (deg positivo). direction: 'left'|'right'
  commandTurn(direction, degrees) {
    const sign = direction === "left" ? -1 : 1;
    const target = normalizeAngle(this.heading + sign * Math.abs(degrees));
    const delay = this._randomDelay();
    const cmd = {
      id: this._cmdId++,
      kind: "turn",
      direction,
      degrees: Math.abs(degrees),
      targetHeading: target,
      issueTime: this.simTime,
      execTime: this.simTime + delay,
      executed: false,
    };
    this.commandQueue.push(cmd);
    return cmd;
  }

  // Ordenar cambio de altitud relativo en metros (+ subir, - bajar).
  // El cambio se aplica sobre la altura AGL objetivo (por defecto 400 m);
  // el avión sigue el terreno automáticamente para mantenerla.
  commandAltitude(deltaM) {
    const targetAgl = this.targetAglCurrent + deltaM;
    const delay = this._randomDelay();
    const cmd = {
      id: this._cmdId++,
      kind: "altitude",
      delta: deltaM,
      targetAgl,
      issueTime: this.simTime,
      execTime: this.simTime + delay,
      executed: false,
    };
    this.commandQueue.push(cmd);
    return cmd;
  }

  // Inicia un giro con curva suave desde el rumbo actual. Si ya había un
  // giro en curso, lo reemplaza arrancando limpio desde el rumbo vigente.
  _startTurn(direction, degrees) {
    const sign = direction === "left" ? -1 : 1;
    this.turnStartHeading = this.heading;
    this.turnTotalAngle = sign * Math.abs(degrees);
    this.turnStartTime = this.simTime;
    // this.turnRateDegS actúa como tasa angular promedio, para mantener
    // duraciones de giro comparables a las de antes.
    this.turnDuration = Math.max(0.1, Math.abs(degrees) / this.turnRateDegS);
    this.turnActive = true;
  }

  _randomDelay() {
    const [lo, hi] = this.pilotDelayRange;
    return lo + Math.random() * (hi - lo);
  }

  pendingCommands() {
    return this.commandQueue.filter((c) => !c.executed);
  }

  step(dt) {
    if (this.finished) return;
    this.simTime += dt;

    // Procesar cola de comandos: activar los que ya deben ejecutarse
    for (const cmd of this.commandQueue) {
      if (!cmd.executed && this.simTime >= cmd.execTime) {
        cmd.executed = true;
        this.executedLog.push({ ...cmd, actualExecTime: this.simTime });
        if (cmd.kind === "turn") {
          this._startTurn(cmd.direction, cmd.degrees);
        } else if (cmd.kind === "altitude") {
          this.targetAglCurrent = cmd.targetAgl;
        }
      }
    }

    // Girar con curva suave (ease-in/ease-out): la velocidad angular
    // arranca en cero, alcanza su pico a mitad de giro y vuelve a cero
    // al terminar, en vez de un giro a tasa constante con arranque/frenado
    // abruptos. Esto da una trayectoria curva realista, sin quiebres.
    if (this.turnActive) {
      const elapsed = this.simTime - this.turnStartTime;
      const t = Math.min(1, elapsed / this.turnDuration);
      const ease = t * t * (3 - 2 * t); // smoothstep
      this.heading = normalizeAngle(this.turnStartHeading + this.turnTotalAngle * ease);
      if (t >= 1) {
        this.turnActive = false;
      }
    }

    // Avanzar posición
    const rad = (this.heading * Math.PI) / 180;
    const dist = this.speedMs * dt;
    this.pos.x += Math.sin(rad) * dist;
    this.pos.y += Math.cos(rad) * dist;
    this.distanceFlown += dist;

    this._updateDerived();
    this._recordFlownPoint();

    // El terreno bajo la nueva posición define el objetivo MSL para
    // mantener siempre targetAglCurrent (400 m por defecto) sobre el suelo.
    // Si no hay dato de terreno (fuera del recorte del DEM / océano), se usa
    // nivel del mar (0 m) como referencia, para que el objetivo de altitud
    // siga actualizándose y las órdenes de subir/bajar no queden "congeladas".
    const terrainForTarget = this.terrainElev ?? 0;
    this.targetAltitudeMsl = terrainForTarget + this.targetAglCurrent;
    const altDiff = this.targetAltitudeMsl - this.altitudeMsl;
    const altStep = this.climbRateMs * dt;
    if (Math.abs(altDiff) <= altStep) {
      this.altitudeMsl = this.targetAltitudeMsl;
    } else {
      this.altitudeMsl += Math.sign(altDiff) * altStep;
    }
  }

  // Recalcula terreno/AGL, desvío lateral y condición de fin de track
  // a partir de this.pos. Se usa tanto en step() como en nudge().
  _updateDerived() {
    const t = this.elevGrid.sample(this.pos.x, this.pos.y);
    this.terrainElev = t;

    const nearest = nearestOnPolyline(this.points, this.pos.x, this.pos.y);
    this.crossTrack = nearest.dist;
    this._nearestAlong = nearest.along;

    const lastPoint = this.points[this.points.length - 1];
    const distToEnd = Math.hypot(this.pos.x - lastPoint.x, this.pos.y - lastPoint.y);
    if (this._nearestAlong >= lastPoint.d - 50 && distToEnd < 2000) {
      this.finished = true;
    }
  }

  // Adelanta o retrocede la simulación manteniendo el rumbo actual fijo
  // (no ejecuta ni deshace órdenes pendientes, solo desplaza la posición
  // y el reloj de simulación en línea recta con el rumbo vigente).
  // deltaSeconds puede ser negativo para retroceder.
  nudge(deltaSeconds) {
    const rad = (this.heading * Math.PI) / 180;
    const dist = this.speedMs * deltaSeconds;
    this.pos.x += Math.sin(rad) * dist;
    this.pos.y += Math.cos(rad) * dist;
    this.simTime = Math.max(0, this.simTime + deltaSeconds);
    this.distanceFlown = Math.max(0, this.distanceFlown + dist);
    this.finished = false;
    this._updateDerived();
    this._recordFlownPoint();

    // Salto instantáneo: reajustar altitud ya mismo al terreno de la nueva posición
    // (0 = nivel del mar si no hay dato de terreno en ese punto).
    const terrainForTarget = this.terrainElev ?? 0;
    this.targetAltitudeMsl = terrainForTarget + this.targetAglCurrent;
    this.altitudeMsl = this.targetAltitudeMsl;
  }

  currentLonLat() {
    // Aproximación: interpolar lon/lat desde el punto más cercano del track
    // (suficiente para el HUD; no es una reproyección exacta de la posición real)
    const nearest = nearestOnPolyline(this.points, this.pos.x, this.pos.y);
    const seg = this.points[nearest.segIndex];
    const seg2 = this.points[Math.min(nearest.segIndex + 1, this.points.length - 1)];
    const segLen = Math.hypot(seg2.x - seg.x, seg2.y - seg.y) || 1;
    const t = Math.min(1, Math.hypot(nearest.x - seg.x, nearest.y - seg.y) / segLen);
    const lon = seg.lon + (seg2.lon - seg.lon) * t;
    const lat = seg.lat + (seg2.lat - seg.lat) * t;
    return { lon, lat };
  }

  // AGL respecto al terreno real cuando hay dato de DEM; si se está fuera
  // del recorte (por ejemplo sobre el océano, sin datos de Bedmap3), se usa
  // nivel del mar (0 m) como referencia en vez de mostrar "sin dato".
  agl() {
    const terrain = this.terrainElev ?? 0;
    return this.altitudeMsl - terrain;
  }

  // true si la posición actual tiene dato real de terreno (dentro del DEM)
  hasTerrainData() {
    return this.terrainElev !== null && this.terrainElev !== undefined;
  }
}
