"""Tile PNGs (same size) into a contact sheet: python3 contact.py OUT.png COLS in1.png in2.png ..."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import numpy as np

from vespera import osm, plan


def read_png(path):
    return osm._png_rgb(open(path, "rb").read()).astype(np.float64) / 255.0


if __name__ == "__main__":
    out, cols = sys.argv[1], int(sys.argv[2])
    imgs = [read_png(p) for p in sys.argv[3:]]
    h, w = imgs[0].shape[:2]
    step = 2
    imgs = [im[::step, ::step] for im in imgs]
    h, w = imgs[0].shape[:2]
    rows = (len(imgs) + cols - 1) // cols
    sheet = np.zeros((rows * h, cols * w, 3))
    for k, im in enumerate(imgs):
        r, c = divmod(k, cols)
        sheet[r * h:(r + 1) * h, c * w:(c + 1) * w] = im[:h, :w]
    plan.write_png(out, np.clip(sheet * 255, 0, 255))
