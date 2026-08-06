import { ElevationGrid, fmtHMS } from './js/geo.js';
import { FlightSim } from './js/sim.js';
import fs from 'fs';

const idx = JSON.parse(fs.readFileSync('data/tracks_index.json'));
const key = '2024_propuesta02_48min';
const meta = idx[key];
const header = JSON.parse(fs.readFileSync(meta.elev_header));
const buf = fs.readFileSync(meta.dem);
const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength/2);
const grid = new ElevationGrid(int16, header);

console.log('track:', meta.name, meta.length_km, 'km,', meta.n_points, 'pts');
console.log('elev header w/h:', header.width, header.height, 'min/max elev', header.min_elev, header.max_elev);

// sample elevation at first point
const p0 = meta.points[0];
console.log('elev at start:', grid.sample(p0.x, p0.y));

const sim = new FlightSim(meta.points, grid, {speedKmh:350, targetAgl:400});
console.log('initial heading', sim.heading.toFixed(1), 'initial alt', sim.altitudeMsl.toFixed(1));
console.log('est flight time', fmtHMS(sim.estFlightTimeSec()));

// issue a turn command right after start
sim.commandTurn('right', 45);
sim.commandAltitude(150);

let steps=0;
for (let t=0; t<60; t+=0.5) {
  sim.step(0.5);
  steps++;
  if (steps % 20 === 0) {
    console.log(`t=${sim.simTime.toFixed(1)}s heading=${sim.heading.toFixed(1)} alt=${sim.altitudeMsl.toFixed(1)} agl=${sim.agl()} crossTrack=${sim.crossTrack.toFixed(0)} pending=${sim.pendingCommands().length}`);
  }
}
console.log('executed log:', sim.executedLog.map(c=>({kind:c.kind, execAt:c.actualExecTime.toFixed(1)})));
console.log('distanceFlown km:', (sim.distanceFlown/1000).toFixed(2));
console.log('OK - no exceptions thrown');
