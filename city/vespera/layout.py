"""Vespera Bay — road master plan.

Freeways and arterials are hand-placed (irregular, following shore and
valleys). District streets are grown from tensor fields (streets.py),
rural and mountain roads are routed over the terrain (paths.py).
Point = (x, y) or (x, y, {"h": height above ground, "z": absolute, "r": fillet}).
"""

# ------------------------------------------------------------------ freeways
F1 = [  # Meridian Loop: lopsided ring with straights and a pinched north side (closed, clockwise from NW)
    (-820, 1560, {"h": 8, "r": 350}),
    (-300, 1880, {"h": 4, "r": 400}),
    (350, 1820, {"h": -11, "r": 350}),
    (650, 1560, {"h": 9, "r": 300}),
    (1050, 1500, {"h": 8, "r": 300}),
    (1500, 1700, {"h": 8, "r": 400}),
    (1850, 1250, {"h": 8, "r": 500}),
    (1840, -150, {"h": 8, "r": 600}),
    (1600, -1100, {"h": 8, "r": 400}),
    (1150, -1450, {"h": 8, "r": 300}),
    (700, -1500, {"h": 9, "r": 300}),
    (250, -1880, {"h": 9, "r": 350}),
    (-220, -1780, {"h": 10, "r": 300}),
    (-300, -1300, {"h": 11, "r": 800}),
    (-260, -700, {"h": 11, "r": 600}),
    (-480, 100, {"h": 11, "r": 600}),
    (-700, 750, {"h": 10, "r": 700}),
]
F2 = [  # Bay Route: over the bay to Isla Corsa and round the west shore
    (-220, -1780, {"h": 10}),
    (-420, -2140, {"h": 14, "r": 400}),
    (-560, -2245, {"z": 44, "r": 4000}),
    (-1310, -2470, {"z": 44, "r": 4000}),
    (-1700, -2420, {"h": 7, "r": 400}),
    (-2100, -2280, {"h": 6, "r": 600}),
    (-2330, -2210, {"z": 15, "r": 900}),
    (-2850, -1760, {"z": 15, "r": 600}),
    (-3000, -1300, {"h": 6, "r": 400}),
    (-3050, -200, {"h": 6, "r": 800}),
    (-2700, 500, {"h": 7, "r": 500}),
    (-1900, 1050, {"h": 8, "r": 700}),
    (-1380, 1240, {"h": 9, "r": 400}),
    (-1070, 1560, {"h": 14, "r": 400}),
    (-820, 1560, {"h": 8}),
]
F3 = [  # Highland Expressway: east past the airfield, up through the highlands, back to the loop
    (1600, -1100, {"h": 8}),
    (2300, -1320, {"h": 6, "r": 500}),
    (3000, -1150, {"h": 6, "r": 400}),
    (3450, -600, {"h": 7, "r": 500}),
    (3600, 300, {"h": 8, "r": 700}),
    (3450, 1000, {"h": 8, "r": 500}),
    (3380, 1700, {"h": 10, "r": 450}),
    (2950, 2120, {"h": 12, "r": 500}),
    (2350, 2230, {"h": 12, "r": 600}),
    (1880, 2030, {"h": 10, "r": 450}),
    (1500, 1700, {"h": 8}),
]
FREEWAYS = [("Meridian Loop", F1, True), ("Bay Route", F2, False), ("Sunset Expressway", F3, False)]
FW_LANES = {"Meridian Loop": 3, "Bay Route": 2, "Sunset Expressway": 2}
# carriageway layouts along the centreline: deck = stacked double-deck viaduct
FW_SECTIONS = {}   # stacked decks need a dedicated structure; off until modelled properly
# freeway-to-freeway T junctions: (main, branch, branch starts here?, name)
FW_JUNCTIONS = [
    ("Meridian Loop", "Bay Route", True, "Corsa Fork"),
    ("Meridian Loop", "Bay Route", False, "Varna Junction"),
    ("Meridian Loop", "Sunset Expressway", True, "Sunset Junction"),
    ("Meridian Loop", "Sunset Expressway", False, "Crown Junction"),
]
# (amplitude m, wavelength m): gentle sideways wander applied to hand-placed roads
# streets cut by hand in the road editor (names are generated, so re-check after layout changes)
REMOVED_ROADS = {"downtown 2~0", "downtown 2~1", "downtown 14"}

MEANDER = {}   # no artificial wander: wobble reads as bad driving lines

# ------------------------------------------------------------------ arterials
ARTERIALS = [
    ("Grand Avenue", "boulevard", [(230, -2000), (250, -1640, {"r": 300}), (360, -1180, {"r": 300}), (310, -800, {"r": 400}),
                                   (480, -380, {"r": 300}), (520, 80, {"r": 300}), (700, 450, {"r": 400}),
                                   (760, 900, {"r": 350}), (900, 1250, {"r": 350}), (880, 1560, {"r": 300}),
                                   (980, 2120)]),
    ("Bayshore Drive", "avenue", [(-380, -2160), (-170, -1760, {"r": 300}), (-210, -1250, {"r": 300}), (-130, -820, {"r": 400}),
                                  (-120, -560, {"r": 200}), (-300, -120, {"r": 400}), (-470, 330)]),
    ("Sunset Boulevard", "boulevard", [(820, -1380), (1060, -1650, {"r": 300}), (1300, -2050, {"r": 500}),
                                       (1800, -2400, {"r": 600}), (2500, -2330, {"r": 600}),
                                       (3100, -2100, {"r": 600}), (3700, -1740)]),
    ("Harbor Road", "avenue", [(-470, 330), (-560, 700, {"r": 160}), (-760, 760, {"r": 150}), (-1040, 700, {"r": 200}),
                               (-1500, 470, {"r": 400}), (-2050, 160, {"r": 500}), (-2450, -250)],
     {"bridge": "steel"}),
    ("Foundry Avenue", "avenue", [(-2050, 160), (-2250, 650, {"r": 400}), (-2200, 1200, {"r": 400}),
                                  (-1950, 1750)]),
    ("Eastside Avenue", "avenue", [(1150, -250), (1500, -380, {"r": 300}), (1900, -300, {"r": 400}),
                                   (2300, -120, {"r": 500}), (2700, -220, {"r": 500}), (3250, -330, {"r": 500}),
                                   (3950, -150)]),
    ("Northgate Boulevard", "avenue", [(-300, 1350), (150, 1260, {"r": 300}), (480, 1130, {"r": 400}),
                                       (1000, 1080, {"r": 400}), (1450, 880, {"r": 400}), (1900, 860, {"r": 400}),
                                       (2500, 700, {"r": 500}), (3180, 560)]),
    ("Palm Drive", "avenue", [(1500, -1000), (1580, -1450, {"r": 300}), (1760, -1900, {"r": 300}),
                              (1950, -2280)]),
    ("Airport Road", "avenue", [(2700, -220), (2600, -700, {"r": 400}), (2700, -1150, {"r": 300}),
                                (2480, -1500, {"r": 400}), (2450, -2310)]),
]

# ------------------------------------------------------------------ districts
# poly: rough outline (water, slopes and freeways cut it further)
DISTRICTS = [
    dict(key="downtown", poly=[(-650, 450), (300, 520), (1000, 250), (1200, -500), (1050, -1250),
                               (550, -1650), (-150, -1720), (-450, -1100)],
         bases=[("grid", -8, 250, -900, 650, 1.0), ("grid", 16, 750, -300, 550, 1.0),
                ("grid", 38, 300, 250, 450, 0.9), ("coast", 1.5, 230)],
         noise=(0.08, 1100), levels=[(520, "avenue"), (235, "street")], seeds=[(450, -450)]),
    dict(key="midtown", poly=[(1100, -1250), (1650, -1150), (1720, -200), (1650, 650), (1050, 600),
                              (1150, -300)],
         bases=[("grid", 22, 1400, -300, 900, 1.0), ("grid", -5, 1350, 300, 500, 0.6)],
         noise=(0.12, 800), levels=[(620, "avenue"), (340, "street")], seeds=[(1400, -300)],
         stagger=True),
    dict(key="oldtown", poly=[(-660, 600), (180, 640), (300, 1000), (120, 1520), (-480, 1560), (-700, 1150)],
         bases=[("grid", 28, -200, 1000, 900, 1.0), ("grid", -20, -450, 800, 350, 0.7)],
         noise=(0.55, 260), levels=[(300, "street"), (160, "lane")], seeds=[(-230, 960)], dtest=0.45),
    dict(key="northgate", poly=[(220, 700), (1300, 520), (1800, 600), (1700, 1100), (1300, 1550),
                                (650, 1720), (100, 1720), (100, 1400)],
         bases=[("grid", 34, 1000, 1050, 1100, 1.0), ("contour", 0.5)],
         noise=(0.14, 900), levels=[(640, "avenue"), (380, "street")], seeds=[(1000, 1050)],
         stagger=True),
    dict(key="eastside", poly=[(1950, 1000), (1850, -200), (1950, -800), (2300, -1150), (3200, -1300),
                               (3450, -700), (3450, 500), (3200, 1150), (2600, 1300)],
         bases=[("grid", -18, 2600, -150, 900, 1.0), ("grid", 22, 2400, 600, 600, 0.8)],
         noise=(0.22, 700), levels=[(660, "avenue"), (400, "street")], seeds=[(2400, -150)],
         exclude=[[(2150, -1080), (3400, -870), (3430, -420), (2200, -580)]],     # airfield
         stagger=True),
    dict(key="beach", poly=[(950, -1700), (1500, -1750), (2200, -2150), (3000, -2000), (3700, -1700),
                            (3700, -2600), (900, -3100)],
         bases=[("coast", 2.0, 600), ("grid", 12, 2200, -2300, 1500, 0.4)],
         noise=(0.1, 900), levels=[(520, "avenue"), (340, "street")], seeds=[(2300, -2400)],
         stagger=True),
    dict(key="port", poly=[(-1000, 600), (-1900, 450), (-2700, -200), (-2900, -350), (-2950, 300),
                           (-2500, 800), (-1500, 900)],
         bases=[("coast", 2.0, 500), ("grid", 40, -2000, 300, 1200, 0.5)],
         noise=(0.04, 1500), levels=[(520, "industrial"), (340, "industrial")], seeds=[(-1900, 250)]),
    dict(key="industrial", poly=[(-2700, 600), (-1450, 900), (-1150, 1250), (-1900, 1450), (-2800, 1300)],
         bases=[("grid", 24, -2100, 1100, 1000, 1.0)],
         noise=(0.05, 1500), levels=[(580, "industrial"), (380, "industrial")], seeds=[(-2100, 1050)]),
    dict(key="westwood", poly=[(-2800, 1300), (-1500, 1450), (-1200, 2100), (-1900, 2500), (-2900, 2200)],
         bases=[("contour", 1.0), ("grid", 5, -2100, 1800, 900, 0.3)],
         noise=(0.3, 500), levels=[(480, "street"), (300, "lane")], seeds=[(-2100, 1800)],
         stagger=True),
    dict(key="island", poly=[(-2400, -2150), (-1250, -2150), (-1250, -3000), (-2400, -3000)],
         bases=[("coast", 1.5, 300), ("grid", 15, -1800, -2500, 600, 0.6)],
         noise=(0.15, 500), levels=[(420, "street"), (280, "lane")], seeds=[(-1800, -2350)],
         exclude=[[(-2300, -2480), (-1380, -2480), (-1380, -2980), (-2300, -2980)]]),   # circuit
    dict(key="lighthouse", poly=[(-500, -1950), (250, -1950), (800, -2600), (600, -3200), (100, -3500),
                                 (-450, -3000)],
         bases=[("coast", 1.2, 300), ("contour", 0.8), ("grid", 50, 100, -2500, 900, 0.3)],
         noise=(0.15, 500), levels=[(460, "street"), (320, "lane")], seeds=[(100, -2500)],
         stagger=True),
]

DISTRICTS += [
    dict(key="riverbend", poly=[(-980, 1750), (-300, 1950), (-200, 2550), (-900, 2700)],
         bases=[("contour", 1.0), ("grid", 70, -600, 2200, 700, 0.4)],
         noise=(0.25, 500), levels=[(440, "street"), (300, "lane")], seeds=[(-600, 2150)]),
    dict(key="villas", poly=[(-100, 2000), (950, 1960), (1050, 2450), (0, 2550)],
         bases=[("contour", 1.0)],
         noise=(0.25, 400), levels=[(460, "lane"), (320, "lane")], seeds=[(450, 2200)]),
]

# ------------------------------------------------------------------ rural / mountain roads
# Each is a chain of waypoints routed by A* over the terrain.
RURAL = [
    ("Varna Canyon Road", "mountain", [(-1950, 1750), (-2550, 2350), (-3250, 3100), (-2500, 3550),
                                       (-1700, 2950), (-1250, 2300), (-650, 1950)], dict(grade=0.10, wiggle=0.5)),
    ("Canyon Spur", "mountain", [(-3250, 3100), (-3750, 2100), (-3550, 900), (-3450, -250), (-2450, -250)], dict(grade=0.11, wiggle=0.6)),
    ("Observatory Road", "mountain", [(930, 2120), (1450, 2750), (2150, 2350), (2750, 1700), (2650, 1150)], dict(grade=0.11, wiggle=0.4)),
    ("Highland Pass", "mountain", [(3250, 1350), (3350, 2600), (2600, 3350), (1500, 3350), (450, 2950),
                                   (-150, 2300), (-150, 1500)], dict(grade=0.10, wiggle=0.5)),
    ("River Road", "rural", [(-650, 1950), (-850, 2600), (-1050, 3300), (-1300, 3800)], dict(grade=0.08, wiggle=0.3)),
    ("Lighthouse Road", "rural", [(230, -2000), (720, -2550), (330, -3420), (-320, -2950), (-380, -2160)], dict(grade=0.09, wiggle=0.6)),
    ("Westpoint Road", "rural", [(-3450, -250), (-3600, -1300), (-3900, -2150), (-3300, -1900), (-3150, -1450)], dict(grade=0.09, wiggle=0.5)),
    ("Corsa Ring", "rural", [(-1450, -2300), (-1420, -2480), (-1850, -2490), (-2280, -2470), (-2100, -2180)], dict(grade=0.09, wiggle=0.4)),
    ("East Hills Road", "rural", [(3950, -150), (3900, 700), (3250, 1350), (2750, 1700)], dict(grade=0.10, wiggle=0.5)),
    ("Quarry Road", "rural", [(-3550, 900), (-2450, 700)], dict(grade=0.09, wiggle=0.4)),
]

# ------------------------------------------------------------------ touge clusters (switchbacks)
TOUGE = [
    dict(name="Devil's Stair", center=(3000, 2700), legs=7, leg_len=230, spacing=64, radius=17, seed=1),
    dict(name="Varna Switchbacks", center=(-3100, 2450), legs=6, leg_len=210, spacing=60, radius=16, seed=2),
    dict(name="Crown Climb", center=(1200, 2950), legs=5, leg_len=200, spacing=58, radius=18, seed=3),
]

# ------------------------------------------------------------------ proving grounds
RACEWAY = [  # Isla Corsa Circuit (closed), technical layout south of the Bay Route
    (-2150, -2560, {"r": 45}), (-1560, -2560, {"r": 40}), (-1470, -2690, {"r": 22}),
    (-1640, -2770, {"r": 60}), (-1790, -2660, {"r": 28}), (-1930, -2860, {"r": 50}),
    (-2160, -2830, {"r": 70}), (-2250, -2700, {"r": 40}),
]
RUNWAY = [(2300, -800), (3250, -600)]          # Corsa Airfield, doubles as the drag strip
SPECIAL = [
    ("Isla Corsa Circuit", "raceway", RACEWAY, dict(closed=True, split=False)),
    ("Corsa Runway", "runway", RUNWAY, dict(split=False, keep_end=True)),
    ("Airfield Taxiway", "street", [(2775, -700), (2700, -380, {"r": 80}), (2700, -220)], {}),
    ("Circuit Pit Road", "street", [(-1850, -2545), (-1820, -2420, {"r": 60})], {"keep_end": True}),
]

# ------------------------------------------------------------------ interchanges (freeway x arterial)
INTERCHANGES = [
    dict(kind="diamond", host="Meridian Loop", cross="Grand Avenue", name="Crown Gate"),
    dict(kind="diamond", host="Meridian Loop", cross="Eastside Avenue", name="Eastside Junction"),
    dict(kind="diamond", host="Sunset Expressway", cross="Eastside Avenue", name="Airfield Junction"),
    dict(kind="diamond", host="Meridian Loop", cross="Sunset Boulevard", name="Beach Junction"),
    dict(kind="diamond", host="Bay Route", cross="Foundry Avenue", name="Foundry Junction"),
    dict(kind="diamond", host="Meridian Loop", cross="Northgate Boulevard", name="Northgate Junction"),
    dict(kind="diamond", host="Bay Route", cross="Corsa Ring", name="Isla Corsa Exit"),
]

LANDMARKS = {
    "spire": (430, -520),
    "suspension_bridge": (-935, -2357),
    "cathedral": (-230, 960),
    "stadium": (2200, 450),
    "observatory": (1450, 2750),
    "lighthouse": (330, -3440),
    "ferris_wheel": (1900, -2690),
    "casino": (-1750, -2520),
    "airfield": (2750, -1000),
}
