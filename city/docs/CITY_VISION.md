# Vespera Bay — city vision

## Assumptions
- Authoring: Blender 4.5 driven by the Python generator in `city/vespera` (reproducible; edit the
  plan, rebuild). Assets: own procedural meshes + CC0 Poly Haven textures/HDRIs.
- Export is by layers. The **road layer** goes out whole, one piece for the entire city
  (`roads.glb`: carriageways, junction pads, markings, curbs/sidewalks, barriers, bridge decks,
  tunnel interiors) plus the road graph as JSON (lanes, nodes, links) for traffic, AI and events.
  **Every other layer** — terrain, water, buildings, landmarks, piers, vegetation, props — is
  exported separately with LOD levels (and streaming cells where it pays off).
- Runtime test: a three.js + Rapier harness (already in `node_modules`). Target: 60 FPS in the
  browser on M4 Pro class hardware.
- Original IP: no names, logos or layouts from existing games.

## Concepts considered
| Concept | Idea | Trade-off |
|---------|------|-----------|
| **A. Vespera Bay** (chosen) | Coastal metropolis wrapped around a sheltered bay with an island, a river delta, canyons NW and highlands NE | Water takes area, bridges become chokepoints (good for pursuits, needs redundancy) |
| B. Cinder Valley | Inland river city between two ranges, dam, desert drag flats, farmland | Plenty of rural road space, but no skyline-over-water and weak coastal fantasy |
| C. Isles of Marrow | City split over five islands linked by bridges and tunnels | Spectacular crossings, but fragmented, poor route choice |

A wins: it carries every racing fantasy of the brief (dense core, waterfront speed, port tech
routes, canyon touge, airfield) inside one coherent geography, and the bay gives the skyline its stage.

## One page
**Name:** Vespera Bay — "the city that wakes up at dusk".
**Geography:** a bay opening south-west; the river Varna enters at its northern tip; Isla Corsa sits in
the bay mouth; a peninsula (Lighthouse Point) closes it from the east; mountains ring the north.
**History:** a fishing and shipbuilding port (Old Quarter, Saltwater Docks) became a trade city; the
1960s built the Bayshore viaduct and the Meridian Loop; the 1990s money moved to the coast (casinos,
Sunset Coast hotels) and the hills (Crown Heights). The old airfield became a night drag venue.
**Tone:** neon-noir, wet streets, warm sodium light against teal skies.
**Racing fantasy:** night street scene that owns the city after dark: downtown sprints, viaduct
speed runs, drift in the container yards, touge in the Varna Canyons, drag at Corsa Airfield,
escapes across the bridges.
**Architecture:** glass-and-steel CBD, 1920s brick and stucco Old Quarter, art-deco hotels and
casinos on the coast, corrugated port/industrial, mid-century hillside villas.

## Districts (14)
| District | Identity | Driving character | Key landmarks |
|----------|----------|-------------------|---------------|
| Meridian | CBD, supertalls | tight grid, underpasses, plazas | Vespera Spire |
| Bayshore | waterfront under the viaduct | fast waterfront, viaduct above | Bayshore Viaduct, marina |
| Old Quarter | hill town, cathedral | narrow twisting lanes, cobbles | Cathedral of St. Vesper |
| Northgate | mid-rise mixed use | avenues, roundabouts | Northgate Arch |
| Eastside | working class + arena | wide avenues, arena lots | Arena |
| Corsa Airfield | proving ground | drag, speed runs | control tower, raceway |
| Sunset Coast | beach, hotels, nightlife | coastal boulevard, casino strip | ferris wheel pier, casino |
| Lighthouse Point | cliff villas | scenic twisty coast road | lighthouse |
| Isla Corsa | resort island | island loop, bridges | Corsa Bridge, casino tower |
| Saltwater Docks | port | container mazes, drift | gantry cranes |
| Foundry Flats | industry, rail | service roads, storm drain | smokestacks, rail yard |
| Westwood | suburbs | curvy loops | water tower |
| Crown Heights | affluent hills | climbs, villa roads | observatory, VESPERA sign |
| Varna Canyons | mountains, dam | touge, switchbacks | Varna Dam, quarry |
