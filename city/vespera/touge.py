"""Switchback (touge) clusters: legs across the fall line joined by tight hairpins."""
import math

import numpy as np

from . import geom, terrain as T


def fall_line(c, r=220.0):
    """Uphill unit vector from a wide central difference (ignores small bumps)."""
    gx = T.height(c[0] + r, c[1]) - T.height(c[0] - r, c[1])
    gy = T.height(c[0], c[1] + r) - T.height(c[0], c[1] - r)
    g = np.array([gx, gy], float)
    n = np.linalg.norm(g)
    return g / n if n > 1e-6 else np.array([0.0, 1.0])


def switchbacks(center, legs=6, leg_len=220.0, spacing=62.0, radius=17.0, seed=0, uphill=None):
    """Return a dense polyline climbing through `legs` legs with hairpins."""
    rng = np.random.default_rng(seed)
    c = np.asarray(center, float)
    d = np.asarray(uphill, float) if uphill is not None else fall_line(c)
    d = d / np.linalg.norm(d)
    a = np.array([-d[1], d[0]])
    total = spacing * (legs - 1)
    pts = []
    for k in range(legs):
        y = -total / 2 + k * spacing + rng.uniform(-0.12, 0.12) * spacing
        half = leg_len / 2 * rng.uniform(0.8, 1.15)
        xs = (-half, half) if k % 2 == 0 else (half, -half)
        shift = rng.uniform(-0.15, 0.15) * leg_len
        for j, x in enumerate(xs):
            yy = y + (j - 0.5) * rng.uniform(0, 0.25) * spacing
            pts.append(c + a * (x + shift) + d * yy)
    radii = [0.0] + [radius * rng.uniform(0.9, 1.35) for _ in pts[1:-1]] + [0.0]
    P, U = geom.fillet_path(pts, radii, arc_step=1.5)
    P, _, _ = geom.resample(P, 4.0, U)
    return P
