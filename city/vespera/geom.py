"""2D polyline geometry: filleted road paths, resampling, offsets, distances."""
import math
import numpy as np


def unit(v):
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-9)


def left_normal(t):
    return np.stack([-t[..., 1], t[..., 0]], axis=-1)


def cum_length(P):
    d = np.linalg.norm(np.diff(P, axis=0), axis=1)
    return np.concatenate([[0.0], np.cumsum(d)])


def fillet_path(ctrl, radii, closed=False, arc_step=2.0):
    """Polyline through control points with corners rounded by circular arcs.

    Returns (points Nx2, u N) where u is the fractional control-point index,
    used to interpolate per-control-point attributes (heights) along the path.
    For closed paths the last point repeats the first with u = n.
    """
    C = np.asarray(ctrl, float)
    n = len(C)
    # desired tangent lengths, then shrink pairs that would overlap on a segment
    info = [None] * n
    Tlen = np.zeros(n)
    for i in range(n):
        if not closed and (i == 0 or i == n - 1):
            continue
        a, p, b = C[(i - 1) % n], C[i], C[(i + 1) % n]
        d1, d2 = p - a, b - p
        l1, l2 = np.linalg.norm(d1), np.linalg.norm(d2)
        if l1 < 1e-6 or l2 < 1e-6:
            continue
        d1, d2 = d1 / l1, d2 / l2
        phi = math.acos(float(np.clip(np.dot(d1, d2), -1, 1)))
        if phi < 1e-3 or radii[i] <= 0:
            continue
        info[i] = (d1, d2, phi)
        Tlen[i] = radii[i] * math.tan(phi / 2)
    segs = n if closed else n - 1
    for _ in range(3):
        for i in range(segs):
            j = (i + 1) % n
            l = np.linalg.norm(C[j] - C[i]) * 0.98
            if Tlen[i] + Tlen[j] > l:
                k = l / (Tlen[i] + Tlen[j])
                Tlen[i] *= k
                Tlen[j] *= k
    arcs = [None] * n
    for i in range(n):
        if info[i] is None or Tlen[i] < 1e-3:
            continue
        d1, d2, phi = info[i]
        p = C[i]
        T = Tlen[i]
        r = T / math.tan(phi / 2)
        p0, p1 = p - d1 * T, p + d2 * T
        sgn = 1.0 if (d1[0] * d2[1] - d1[1] * d2[0]) > 0 else -1.0
        ctr = p0 + np.array([-d1[1], d1[0]]) * sgn * r
        a0 = math.atan2(p0[1] - ctr[1], p0[0] - ctr[0])
        a1 = math.atan2(p1[1] - ctr[1], p1[0] - ctr[0])
        da = a1 - a0
        if sgn > 0 and da < 0:
            da += 2 * math.pi
        if sgn < 0 and da > 0:
            da -= 2 * math.pi
        k = max(2, int(abs(da) * r / arc_step) + 1)
        ang = a0 + da * np.linspace(0, 1, k)
        arcs[i] = np.stack([ctr[0] + r * np.cos(ang), ctr[1] + r * np.sin(ang)], 1)
    pieces, us = [], []
    for i in range(n):
        if arcs[i] is not None:
            pieces.append(arcs[i])
            us.append(np.full(len(arcs[i]), float(i)))
        else:
            pieces.append(C[i:i + 1])
            us.append(np.array([float(i)]))
    if closed:
        pieces.append(pieces[0][:1])
        us.append(np.array([float(n)]))
    P = np.vstack(pieces)
    U = np.concatenate(us)
    keep = np.concatenate([[True], np.linalg.norm(np.diff(P, axis=0), axis=1) > 1e-6])
    return P[keep], U[keep]


def resample(P, spacing, U=None, closed=False):
    """Uniform arc-length resampling. Returns (points, u, s)."""
    if closed and np.linalg.norm(P[0] - P[-1]) > 1e-6:
        P = np.vstack([P, P[:1]])
        if U is not None:
            U = np.concatenate([U, U[:1]])
    s = cum_length(P)
    L = s[-1]
    n = max(2, int(round(L / spacing)) + 1)
    si = np.linspace(0, L, n)
    x = np.interp(si, s, P[:, 0])
    y = np.interp(si, s, P[:, 1])
    u = np.interp(si, s, U) if U is not None else si / max(L, 1e-9)
    return np.stack([x, y], 1), u, si


def tangents(P, closed=False):
    if closed:
        T = np.roll(P, -1, 0) - np.roll(P, 1, 0)
    else:
        T = np.empty_like(P)
        T[1:-1] = P[2:] - P[:-2]
        T[0] = P[1] - P[0]
        T[-1] = P[-1] - P[-2]
    return unit(T)


def gaussian_smooth(z, s, sigma):
    """Smooth samples z(s) (uniform spacing) with gaussian sigma in metres."""
    if len(z) < 3 or sigma <= 0:
        return z.copy()
    ds = (s[-1] - s[0]) / (len(s) - 1)
    k = max(1, int(3 * sigma / ds))
    x = np.arange(-k, k + 1) * ds
    w = np.exp(-0.5 * (x / sigma) ** 2)
    w /= w.sum()
    zp = np.concatenate([np.full(k, z[0]), z, np.full(k, z[-1])])
    return np.convolve(zp, w, mode="valid")


def seg_intersect(p1, p2, q1, q2):
    """Proper intersection of segments; returns (t,u) or None."""
    r = p2 - p1
    s = q2 - q1
    den = r[0] * s[1] - r[1] * s[0]
    if abs(den) < 1e-12:
        return None
    qp = q1 - p1
    t = (qp[0] * s[1] - qp[1] * s[0]) / den
    u = (qp[0] * r[1] - qp[1] * r[0]) / den
    if 0 <= t <= 1 and 0 <= u <= 1:
        return t, u
    return None


def line_intersect(p, d, q, e):
    """Intersection of infinite lines p+t d and q+u e -> (t,u) or None."""
    den = d[0] * e[1] - d[1] * e[0]
    if abs(den) < 1e-9:
        return None
    qp = q - p
    t = (qp[0] * e[1] - qp[1] * e[0]) / den
    u = (qp[0] * d[1] - qp[1] * d[0]) / den
    return t, u


def project_to_polyline(P, x):
    """Closest point on polyline P to point x -> (dist, seg_index, t, point)."""
    a = P[:-1]
    b = P[1:]
    ab = b - a
    L2 = np.maximum((ab ** 2).sum(1), 1e-12)
    t = np.clip(((x - a) * ab).sum(1) / L2, 0, 1)
    proj = a + ab * t[:, None]
    d = np.linalg.norm(proj - x, axis=1)
    i = int(np.argmin(d))
    return float(d[i]), i, float(t[i]), proj[i]


def dist_to_polyline_grid(X, Y, P, chunk=200000):
    """Distance from grid points to polyline P, plus nearest param s and segment dir.

    Returns (dist, s_along, nearest_index_float)."""
    pts = np.stack([X.ravel(), Y.ravel()], 1)
    s_cum = cum_length(P)
    D = np.full(len(pts), np.inf)
    S = np.zeros(len(pts))
    a = P[:-1]
    ab = P[1:] - a
    L2 = np.maximum((ab ** 2).sum(1), 1e-12)
    for c0 in range(0, len(pts), chunk):
        q = pts[c0:c0 + chunk]
        best = np.full(len(q), np.inf)
        bs = np.zeros(len(q))
        for i in range(len(a)):
            t = np.clip(((q[:, 0] - a[i, 0]) * ab[i, 0] + (q[:, 1] - a[i, 1]) * ab[i, 1]) / L2[i], 0, 1)
            pr = a[i] + t[:, None] * ab[i]
            d = np.hypot(q[:, 0] - pr[:, 0], q[:, 1] - pr[:, 1])
            m = d < best
            best[m] = d[m]
            bs[m] = s_cum[i] + t[m] * math.sqrt(L2[i])
        D[c0:c0 + chunk] = best
        S[c0:c0 + chunk] = bs
    return D.reshape(X.shape), S.reshape(X.shape)


def point_in_poly(px, py, poly):
    """Vectorised even-odd point in polygon test."""
    poly = np.asarray(poly, float)
    inside = np.zeros(np.shape(px), bool)
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        cond = ((yi > py) != (yj > py)) & (px < (xj - xi) * (py - yi) / ((yj - yi) + 1e-12) + xi)
        inside ^= cond
        j = i
    return inside


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def poly_area(poly):
    p = np.asarray(poly)
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def catmull_rom(ctrl, spacing=4.0, closed=False, alpha=0.5, samples=24):
    """Centripetal Catmull-Rom spline through the control points (smooth, no overshoot loops).
    Returns (points, u) with u = fractional control index, resampled at `spacing`."""
    C = np.asarray(ctrl, float)
    n = len(C)
    if n < 2:
        return C, np.zeros(len(C))
    if closed:
        P = np.vstack([C[-1:], C, C[:2]])
    else:
        P = np.vstack([2 * C[0] - C[1], C, 2 * C[-1] - C[-2]])
    out, us = [], []
    segs = n if closed else n - 1
    for i in range(segs):
        p0, p1, p2, p3 = P[i], P[i + 1], P[i + 2], P[i + 3]
        t0 = 0.0
        t1 = t0 + max(np.linalg.norm(p1 - p0), 1e-6) ** alpha
        t2 = t1 + max(np.linalg.norm(p2 - p1), 1e-6) ** alpha
        t3 = t2 + max(np.linalg.norm(p3 - p2), 1e-6) ** alpha
        t = np.linspace(t1, t2, samples, endpoint=False)[:, None]
        a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
        a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
        a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
        b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
        b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
        c = (t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2
        out.append(c)
        us.append(i + np.linspace(0, 1, samples, endpoint=False))
    out.append(C[:1] if closed else C[-1:])
    us.append(np.array([float(n if closed else n - 1)]))
    Q = np.vstack(out)
    U = np.concatenate(us)
    return resample(Q, spacing, U)[:2]


def relax_to(P, iters=30, tether=18.0):
    """Laplacian smoothing; every point stays within `tether` metres of where it started."""
    P0 = np.asarray(P, float)
    P = P0.copy()
    for _ in range(iters):
        Q = P.copy()
        Q[1:-1] = 0.25 * P[:-2] + 0.5 * P[1:-1] + 0.25 * P[2:]
        d = Q - P0
        n = np.linalg.norm(d, axis=1, keepdims=True)
        Q = np.where(n > tether, P0 + d * (tether / np.maximum(n, 1e-9)), Q)
        P = Q
    return P


def fair(P, rmin, iters=300):
    """Locally relax a polyline wherever its curvature exceeds 1/rmin (ends stay put)."""
    P = np.asarray(P, float).copy()
    if len(P) < 5:
        return P
    for _ in range(iters):
        d = np.diff(P, axis=0)
        h = np.unwrap(np.arctan2(d[:, 1], d[:, 0]))
        ds = np.maximum(np.linalg.norm(d, axis=1), 1e-6)
        k = np.abs(np.diff(h)) / (0.5 * (ds[:-1] + ds[1:]))
        bad = k > 1.0 / rmin
        if not bad.any():
            break
        m = np.zeros(len(P), bool)
        m[1:-1] = bad
        for _ in range(3):
            m[1:-1] |= m[:-2] | m[2:]
        m[0] = m[-1] = False
        Q = P.copy()
        Q[1:-1] = np.where(m[1:-1, None], 0.25 * P[:-2] + 0.5 * P[1:-1] + 0.25 * P[2:], P[1:-1])
        P = Q
    return P
