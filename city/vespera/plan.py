"""Top-down debug plan rendered to PNG with numpy only."""
import struct
import zlib

import numpy as np

from . import geom, terrain as T, world as W


def write_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].astype(np.uint8).tobytes() for y in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)


class Canvas:
    def __init__(self, region, mpp):
        self.x0, self.y0, self.x1, self.y1 = region
        self.mpp = mpp
        self.w = int((self.x1 - self.x0) / mpp)
        self.h = int((self.y1 - self.y0) / mpp)
        self.img = np.zeros((self.h, self.w, 3), float)

    def grid(self):
        xs = self.x0 + (np.arange(self.w) + 0.5) * self.mpp
        ys = self.y1 - (np.arange(self.h) + 0.5) * self.mpp
        return np.meshgrid(xs, ys)

    def to_px(self, P):
        return np.stack([(P[:, 0] - self.x0) / self.mpp, (self.y1 - P[:, 1]) / self.mpp], 1)

    def stroke(self, P, width_m, color, alpha=1.0):
        P = np.asarray(P, float)
        if len(P) < 2:
            return
        Pd, _, _ = geom.resample(P, max(self.mpp * 0.6, 0.5))
        px = self.to_px(Pd)
        r = max(0.55, width_m / 2 / self.mpp)
        ri = int(np.ceil(r))
        offs = [(dx, dy) for dx in range(-ri, ri + 1) for dy in range(-ri, ri + 1) if dx * dx + dy * dy <= r * r + 0.3]
        xs = np.round(px[:, 0]).astype(int)
        ys = np.round(px[:, 1]).astype(int)
        col = np.asarray(color, float)
        for dx, dy in offs:
            x = xs + dx
            y = ys + dy
            m = (x >= 0) & (x < self.w) & (y >= 0) & (y < self.h)
            self.img[y[m], x[m]] = self.img[y[m], x[m]] * (1 - alpha) + col * alpha

    def dot(self, p, r_m, color):
        self.stroke(np.array([p, np.asarray(p) + 0.01]), r_m * 2, color)

    def save(self, path):
        write_png(path, np.clip(self.img * 255, 0, 255))


def terrain_image(cv, style="map"):
    X, Y = cv.grid()
    H = T.height(X, Y)
    gy, gx = np.gradient(H, -cv.mpp, cv.mpp)
    shade = np.clip(0.8 + (-gx * 0.7 + gy * 0.7) * 0.9, 0.3, 1.25)
    if style == "night":
        land = np.stack([0.11 + H * 0.0004, 0.13 + H * 0.0004, 0.12 + H * 0.0004], -1)
        img = land * shade[..., None]
        water = H < 0
        img[water] = np.array([0.05, 0.09, 0.13]) + np.clip(H[water, None], -20, 0) * 0.001
    else:
        t = np.clip(H / 320.0, 0, 1)[..., None]
        low = np.array([0.50, 0.58, 0.40])
        mid = np.array([0.55, 0.50, 0.36])
        high = np.array([0.85, 0.83, 0.80])
        land = np.where(t < 0.4, low + (mid - low) * (t / 0.4), mid + (high - mid) * ((t - 0.4) / 0.6))
        img = land * shade[..., None]
        water = H < 0
        img[water] = np.array([0.20, 0.36, 0.52]) + np.clip(H[water, None], -25, 0) * 0.006
        band = (np.floor(H / 20) % 2 == 0) & ~water
        img[band] *= 0.96
    cv.img = img


ROAD_COL = {"freeway": (0.95, 0.72, 0.25), "ramp": (0.95, 0.62, 0.22), "boulevard": (0.92, 0.92, 0.9),
            "avenue": (0.92, 0.92, 0.9), "street": (0.85, 0.85, 0.82), "lane": (0.8, 0.8, 0.76),
            "mountain": (0.95, 0.55, 0.45), "rural": (0.85, 0.7, 0.55), "industrial": (0.7, 0.7, 0.72),
            "raceway": (0.4, 0.9, 0.5), "runway": (0.6, 0.6, 0.65)}


def render(path, net=None, roads=None, region=None, mpp=8.0, style="map", show_nodes=False, extra=None, grid=0):
    from .network import hw
    E = W.PLAY + 600
    region = region or (-E, -E, E, E)
    cv = Canvas(region, mpp)
    terrain_image(cv, style)
    items = []
    if net is not None:
        items = [(e.P, e.cls, e) for e in net.edges]
    elif roads is not None:
        items = [(r.P, r.cls, None) for r in roads]
    items.sort(key=lambda it: {"freeway": 3, "ramp": 2}.get(it[1], 0))
    for P, cls, e in items:
        col = np.array(ROAD_COL.get(cls, (0.8, 0.8, 0.8)))
        if style == "night":
            col = col * 0.85
        if e is not None and getattr(e, "tunnel", None) is not None and e.tunnel.mean() > 0.5:
            col = col * 0.45
        cv.stroke(P, max(hw(cls) * 2, mpp * 1.1), col)
    if show_nodes and net is not None:
        for n in net.nodes:
            col = {"junction": (1, 0.15, 0.15), "end": (1, 0.9, 0), "joint": (0.3, 1, 0.3)}.get(getattr(n, "kind", ""), (1, 1, 1))
            cv.dot(n.pos, 1.5 * mpp, col)
    if grid:
        for g in np.arange(-W.EXTENT, W.EXTENT + 1, grid):
            cv.stroke(np.array([[g, region[1]], [g, region[3]]]), mpp * 0.6, (1, 1, 1), 0.35)
            cv.stroke(np.array([[region[0], g], [region[2], g]]), mpp * 0.6, (1, 1, 1), 0.35)
        cv.dot((0, 0), mpp * 2.5, (1, 0, 0))
    if extra:
        extra(cv)
    cv.save(path)
    return path


def render_labeled(path, net, info=None, mpp=7.0):
    """Night-style world map with district names, landmarks and freeway labels."""
    from . import audit, font, layout as LY
    E = W.PLAY + 400
    region = (-E, -E, E, E)

    def extra(cv):
        for d in LY.DISTRICTS:
            c = np.asarray(d["poly"], float).mean(0)
            q = cv.to_px(c[None])[0]
            font.draw(cv.img, audit.NAMES.get(d["key"], d["key"]), int(q[0]), int(q[1]), 2, (1.0, 0.85, 0.4))
        for name, c in audit.ZONES.items():
            q = cv.to_px(np.array([c], float))[0]
            font.draw(cv.img, name, int(q[0]), int(q[1]), 2, (0.6, 0.85, 1.0))
        for name, c in LY.LANDMARKS.items():
            cv.dot(np.array(c, float), 22, (1.0, 0.3, 0.6))
            q = cv.to_px(np.array([c], float))[0]
            font.draw(cv.img, name.replace("_", " "), int(q[0]), int(q[1]) + 12, 1, (1.0, 0.6, 0.8))
        for name, pts, _closed in LY.FREEWAYS:
            p = np.array(pts[len(pts) // 3][:2], float)
            q = cv.to_px(p[None])[0]
            font.draw(cv.img, name, int(q[0]), int(q[1]) - 14, 1, (1.0, 0.75, 0.3))
        if info:
            y = 16
            for line in info:
                font.draw(cv.img, line, 10, y, 1, (0.9, 0.9, 0.9), center=False)
                y += 11
        font.draw(cv.img, "VESPERA BAY", cv.w // 2, 20, 3, (1, 1, 1))
        for k in range(0, 1001, 250):
            pass
        x0 = cv.w - 30 - int(1000 / cv.mpp)
        cv.img[cv.h - 22:cv.h - 19, x0:cv.w - 30] = 1.0
        font.draw(cv.img, "1 KM", (x0 + cv.w - 30) // 2, cv.h - 32, 1)

    return render(path, net=net, region=region, mpp=mpp, style="night", extra=extra)
