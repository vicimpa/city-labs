# Reference analysis — Vespera Bay

Sources: `../city-lab/reference_pack` (10 NFS maps, 9 night renders). Used as principles only;
nothing is traced or copied.

## Topology lessons (maps)

| # | Principle | Seen in | Vespera Bay status (plan v2) | Action |
|---|-----------|---------|------------------------------|--------|
| T1 | Freeway orbit around the core + spokes to outer districts; freeways run *through* districts, not only around | Bayview, Lakeshore, Ventura, Tri-City | Inner loop F1 + bay loop F2 + east spoke F3 | Make F2+F1 a true second orbital; one freeway S-curves through a district (Ventura style) |
| T2 | Compact district "blobs" separated by water / ridges, linked by bridges and causeways | Ventura, Tri-City, Bayview | Bay + island + peninsula, 14 districts | Keep; add 3+ approaches per district |
| T3 | 40–55 % of road length is rural / canyon: a web of curvy loops every 300–600 m, not single roads | Lakeshore, Palm City, Fortune Valley | 46 of 296 km (16 %); single isolated lines | Rural loop mesh generator (POIs → A* → neighbourhood graph) |
| T4 | Junction vocabulary: T and Y junctions, roundabouts, lens splits; 4-way crossings mostly downtown | Lakeshore, Rockport, Palm City | 560 four-way vs 349 T | Bias grids to T-junctions outside the core, add roundabouts at arterial crossings |
| T5 | Almost no dead ends: loops, turnaround circles, connectors | Rockport, Lakeshore | 233 dead ends | Connect or delete every stub; turnaround loops only by design |
| T6 | Downtown is compact (blocks ~80–130 m), slightly tilted grid, cut by a river or channel, a freeway hugging one side | Lakeshore, Olympic City | 2×2 km fairly uniform grid | Smaller, denser core; channel; irregular block sizes, plazas, alleys |
| T7 | Canyon / touge clusters: densely packed hairpins in a dedicated mountain zone, 1–2 links to the city | Ventura NE, Bayview NW, Carbon canyons | Long gentle mountain roads | Authored switchback clusters on steep faces |
| T8 | Arterial ring around each district gives a self-contained circuit | Ventura (yellow loops), Palmont | none | District ring arterials |
| T9 | Waterfront roads along every coast and river, bridges as chokepoints and landmarks | all | partial | Continuous shore roads, 5+ bridges |
| T10 | Interchange variety: cloverleaf, trumpet, Y-fork, flyovers | Lakeshore, Palm City | diamonds only | Mix interchange types per location |
| T11 | Technical spaces: airfield, raceway, port yards, stadium lots | Palm City, Rockport, Ventura | planned only | Raceway + airfield + container yard + arena lot |
| T12 | The whole map is useful: roads reach the edges, no decorative-only zones | Lakeshore, Palm City | empty NE / NW | Rural mesh to the mountain rim |

## Visual lessons (renders)

| # | Principle | Seen in | Action |
|---|-----------|---------|--------|
| V1 | Night palette: deep blue/teal sky, warm sodium street light, magenta/cyan neon accents | 02, 08, 09 | Per-district color scripts; emissive signage |
| V2 | Wet asphalt reflections double every light | 08, 09 | Wet road shader, puddle mask |
| V3 | One hero tower and a supertall cluster readable from everywhere, often across water | 03, 05, 07 | Vespera Spire + waterfront skyline facing the bay |
| V4 | Waterfront landmarks: ferris wheel, suspension bridge on the horizon | 04, 06 | Pier wheel on Sunset Coast, Corsa Bridge |
| V5 | Depth through layers of lit windows, lamps and haze | 01, 07 | Procedural lit-window facades, height fog |
| V6 | Elevated freeways read as ribbons of light | 01 | Lamp rows on viaducts, light strips on barriers |
| V7 | Suburban strips: palms, low lit storefronts, parking lots | 02, 03 | Palm/lamp instancing, lit ground floors |
| V8 | Neon hero signage marks nightlife districts | 08 | Casino strip + Neon Mile signage kit |
