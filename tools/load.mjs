// Node-side world loading for tools: the VSPB world with the road mesh built from the graph.
import fs from 'node:fs';
import { decode } from '../format/vspb.js';
import { withDefaults } from '../format/world.js';
import { RoadWorld } from '../world/roadworld.js';

export async function loadNodeWorld(path = 'city/data/vespera.vspb') {
  const doc = withDefaults(await decode(fs.readFileSync(path)));
  const roadWorld = new RoadWorld(doc);
  Object.defineProperty(doc.layers.roads, 'mesh', { value: roadWorld.mesh(), configurable: true, writable: true });
  return { doc, roadWorld, ...doc.layers };
}
