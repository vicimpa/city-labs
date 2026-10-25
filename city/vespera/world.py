"""Vespera Bay — macro geography (authored by hand, roughened by noise).

Coordinates in metres: +X east, +Y north, Z up, sea level 0.
Shapes here are deliberately rough sketches: the terrain module warps them
with noise so coastlines, ridges and valleys read as natural.
"""

EXTENT = 5000.0          # terrain covers [-EXTENT, EXTENT]^2
PLAY = 4000.0            # playable half-size

# Mainland outline (counter-clockwise, rough). The sea and the bay are outside.
MAINLAND = [
    (-5200, -2600), (-4000, -2450), (-3350, -2100), (-2900, -1500), (-2650, -800),
    (-2350, -300), (-1850, 120), (-1350, 260), (-1000, 520),          # west shore of the bay, up to the river mouth
    (-760, 470), (-520, 210), (-300, -150), (-120, -620), (40, -1050),  # NE shore of the bay (downtown waterfront)
    (-60, -1500), (-380, -1900), (-560, -2400), (-480, -2950),          # peninsula, bay side
    (-150, -3350), (380, -3480), (900, -3250),                          # Lighthouse Point
    (1350, -2850), (2000, -2600), (2700, -2450), (3400, -2150),         # Sunset Coast (open sea, beaches)
    (4100, -1900), (5200, -1800),
    (5200, 5200), (-5200, 5200),
]
# Islands in the bay
ISLANDS = [
    [(-2350, -2300), (-1950, -2050), (-1500, -2080), (-1250, -2350), (-1380, -2700),
     (-1850, -2850), (-2250, -2700)],                                   # Isla Corsa
    [(-700, -2050), (-560, -1980), (-470, -2120), (-620, -2220)],        # Gull Rock
]

# River Varna: from the north mountains into the bay tip
RIVER = [(-1500, 5200), (-1350, 4000), (-1050, 3300), (-1250, 2600), (-950, 2000),
         (-1100, 1450), (-900, 1000), (-880, 520)]
RIVER_HALFWIDTH = 34.0

# Relief: (cx, cy, rx, ry, height) soft elevated masses; ridged noise adds the detail
MOUNTAINS = [
    (-2900, 2700, 1700, 1400, 240),    # Canyon range (NW)
    (-3800, 600, 900, 1400, 170),      # west hills behind the port
    (1500, 2700, 1300, 800, 170),      # Crown Heights (observatory)
    (3600, 2600, 1500, 1700, 300),     # NE backdrop
    (3900, 400, 700, 1300, 140),       # east ridge
    (-100, 2900, 700, 700, 120),       # Varna gorge shoulder
]
# Areas kept flat for city building: (cx, cy, rx, ry, strength 0..1)
FLATS = [
    (700, -200, 1350, 1150, 1.0),      # downtown + midtown
    (-200, 800, 700, 500, 0.85),       # old quarter (gentle hill kept)
    (-2200, -500, 900, 1200, 1.0),     # port + foundry flats
    (2400, -600, 1300, 1000, 0.95),    # eastside plain + airfield
    (1700, -2300, 1300, 450, 0.8),     # sunset coast strip
    (-1800, -2450, 600, 400, 0.7),     # island
    (1200, 1300, 900, 500, 0.6),       # northgate / foothills
    (-2400, 1200, 700, 500, 0.6),      # westwood suburbs
]
# Small hills that give districts character
KNOLLS = [
    (-250, 900, 300, 300, 24),         # Old Quarter hill (cathedral)
    (1100, 650, 260, 200, 10),         # park hill
    (-1750, -2450, 300, 220, 28),      # island hill
    (2900, 1100, 500, 400, 45),        # east suburbs hill
]

DISTRICTS = {
    "downtown":  dict(name="Meridian", label=(650, -250)),
    "oldtown":   dict(name="Old Quarter", label=(-300, 950)),
    "port":      dict(name="Saltwater Docks", label=(-2300, -900)),
    "industrial": dict(name="Foundry Flats", label=(-1900, 300)),
    "eastside":  dict(name="Eastside", label=(2300, -300)),
    "airfield":  dict(name="Corsa Airfield", label=(2900, -1100)),
    "beach":     dict(name="Sunset Coast", label=(1800, -2350)),
    "island":    dict(name="Isla Corsa", label=(-1800, -2450)),
    "northgate": dict(name="Northgate", label=(1000, 1300)),
    "heights":   dict(name="Crown Heights", label=(1600, 2600)),
    "canyons":   dict(name="Varna Canyons", label=(-2800, 2600)),
    "westwood":  dict(name="Westwood", label=(-2400, 1300)),
}
