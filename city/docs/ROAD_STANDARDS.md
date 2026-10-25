# Vespera Bay — road & roadside standard

Every road element in the generator follows this sheet. Values are real-world
engineering practice (NACTO Urban Street Design Guide, AASHTO Green Book /
Roadside Design Guide, FHWA Lighting Handbook, municipal lighting criteria),
widened where arcade driving at 150–300 km/h needs it.

## 1. Cross-section, by class
| Class | Lanes / dir | Lane | Median | Shoulder / parking | Curb | Sidewalk zones | Edge treatment |
|---|---|---|---|---|---|---|---|
| Freeway carriageway | 2–4 | 3.7 | concrete jersey, 1.2 | 3.0 outer, 1.0 inner | none | none | jersey both sides; grass verge 3 m when at grade |
| Ramp / connector | 1–2 | 4.0 | — | 1.5 | none | none | jersey both sides |
| Boulevard | 3 | 3.5 | planted 6–8 m, trees | 0.6 | 0.15 | 5.0 (frontage 1 / walk 2.5 / amenity 1.5) | trees + lamps in amenity zone |
| Avenue | 2 | 3.4 | double yellow 0.6 | 2.4 parking | 0.15 | 4.5 | lamps, trees, bus stops |
| Street | 1 | 3.6 | double yellow 0.3 | 2.3 parking | 0.15 | 3.5 | lamps |
| Lane (old town) | 1 | 3.1 | — | 0.4 | 0.12 | 2.2 | bollards, wall lamps |
| Rural / mountain | 1 | 3.6 | yellow centre | 1.0–1.4 gravel | none | none | guardrail where drop > 1.2 m within 6 m, delineators every 50 m |
| Industrial | 1 | 4.2 | dashed yellow | 1.6 | 0.15 low | none | fences, gates |

Sidewalk zones (NACTO): frontage (against buildings) · pedestrian through-zone ·
amenity/furniture zone at the curb (lamps, trees, signs, hydrants, benches).

## 2. Junctions
- Curb return radius: lane/street 6 m, avenue 9 m, boulevard 12 m, industrial 15 m (trucks).
- Crosswalk: zebra 3 m wide, set back 1 m from the curb return; stop line 0.4 m, 1.5 m before the crosswalk.
- Signals: avenue × avenue and anything with a boulevard → traffic lights (mast arm over the
  approach, on the far-right corner); street × avenue → stop signs on the street; lanes → none.
- Curb extensions (bulb-outs) where a street with parking meets an avenue.
- Roundabouts for 5+ arm nodes outside downtown (central island radius 12–20 m).

## 3. Interchanges
- Diamond for arterials, cloverleaf/parclo where space allows, trumpet or directional T for
  freeway-to-freeway, stack for crossing freeways.
- Diverge/merge taper 90–120 m, connector design speed 60–80 km/h (radius ≥ 120 m), loops R ≥ 55 m.
- Vertical clearance 6.5 m surface-to-surface (≥ 5 m under the deck); decks 1.7 m deep.
- Gore areas: chevron hatching + crash cushion at every split.
- Overhead sign gantries 300 m and at each exit; exit number signs at the gore.

## 4. Grade, cut and fill
- Max grade: freeway 5–6 %, ramps 7 %, arterials 8 %, streets 10–12 % (hill districts up to 17 %).
- Flat verge 1.2 m beyond the road edge, then cut face 1:0.8 (rock) or fill 1:1.7;
  retaining walls in urban areas when a cut exceeds 2.5 m; drainage ditch on rural cuts.
- Guardrail warrant: fill ≥ 1.2 m at 1:3 or steeper, water, ditch ≥ 1 m, piers/columns within 6 m.

## 5. Lighting & furniture
- Street lights: avenue/boulevard 10–12 m poles every 35–40 m, staggered; streets 8 m every
  45 m one side; freeways 14 m high-mast on the median every 60 m; tunnels continuous strip.
- Trees in the amenity zone every 9–12 m on boulevards/avenues; palms on the coast.
- Bus stops every ~400 m on avenues; hydrants, benches, bins near junctions.
- Rural: reflective delineators every 50 m, chevron signs on curves with R < 80 m.

## 6. Bridges, viaducts, tunnels
- Piers every 30–40 m (hammerhead for wide decks), parapet 1.1 m + lamp rows.
- Tunnel: 7 m clear height, portal facade, continuous lights, emergency walkways 1 m.

## 7. Gameplay overlays (from the reference maps)
- Clear readable corner sightlines at junction pads; no pole within 1.5 m of a curb on race routes.
- Breakable props (bins, signs, fences) on shortcuts; solid objects only behind curbs/barriers.

Sources: NACTO Urban Street Design Guide (curb extensions, corner radii); Toronto & Minneapolis
curb-radii guidelines; AASHTO Roadside Design Guide via NDDOT, Henrico, NCDOT, TxDOT, LA DOTD
barrier guides; FHWA Lighting Handbook and municipal lighting criteria (Phoenix, Pasco, Goodyear,
Queen Creek, Ankeny); interchange type notes (diamond, cloverleaf, trumpet, stack).

## 8. Automatic design checks (`vespera/validate.py`, run on every export → `data/issues.json`)
| Rule | Check | Limit | Source |
|---|---|---|---|
| R1 radius | curvature inside trimmed edge | freeway 300 m, avenue 70, street 35, lane 14, rural 45, mountain 16, ramp 55 | AASHTO Rmin = V²/(127(e+f)), compressed for arcade speeds |
| R2 kink | heading jump between 4 m samples | 12° (25° lanes/mountain) | curvature continuity (clothoid principle) |
| R3 wobble | reverse curves closer than 60 m | none allowed | broken-back / reverse-curve guidance |
| V1 grade | max grade per class | freeway 5–6 %, ramps 7 %, avenue 8 %, street 10 % (hill districts 17 %) | Green Book grade controls |
| V2 vertical curve | K = curve length per % grade change | freeway 60, avenue 22, street 12, lane 6 | TxDOT RDM 4.8.2 K tables (scaled) |
| J1 angle | angle between adjacent arms | ≥ 60° (lanes 55°, ramp terminals 45°) | FHWA / ITE: 75° desirable, Iowa DOT: 60–75 acceptable, < 60 realign |
| J2 spacing | distance between junctions on a road | arterials 70 m, streets 40 m | access-management practice |
| J3 degree | arms per junction | ≤ 4 (more → roundabout) | — |
| J4 approach | minor arm straight for 20 m beyond the pad | R ≥ 120 m | sight-triangle practice |
| I1 weaving | ramp ends on one carriageway | ≥ 250 m apart | TxDOT 9.4.4 / WSDOT 1360 (scaled) |

Generator rules that keep these green: no artificial meander; streets simplified + splined;
fairing to the class radius; minor arms turned square (or dropped when there is no room);
parabolic crest/sag curves at grade separations sized by K; grade limit then smoothing;
junction pads tilted to the arms' grade plane; diamond interchanges dropped when they would
weave with a freeway junction (< 1.1 km).
