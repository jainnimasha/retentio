#!/usr/bin/env python3
"""
fix_svg_transparency.py

Fixes the "checkerboard baked into the pixels instead of real transparency"
problem that shows up in some Canva SVG exports.

WHAT'S HAPPENING IN THESE FILES
Canva sometimes exports a design's background as one big embedded PNG
<image> inside the SVG, and that PNG has the transparency-indicator
checkerboard pattern actually painted into its pixels (flat RGB, no alpha
channel) instead of exporting a real alpha channel. The result: browsers
render a visible gray/white checker instead of true transparency.

WHAT THIS SCRIPT DOES
1. Finds every embedded base64 PNG <image> inside the SVG.
2. For each one, tells apart "checkerboard background" pixels from "real
   content" pixels (photos, icons, text, lines, cards) using two signals:
     - chroma: checker squares are neutral gray/white (R≈G≈B).
       Anything with real color (icons, text, lines, photos) is protected
       automatically, regardless of the rest of this logic.
     - local texture: the checkerboard has fast small-scale alternation
       (high local standard deviation) whereas flat content (a white card
       interior) or smooth gradients (drop shadows) do not.
   Only pixels that are BOTH neutral AND texturally "checker-like" get
   keyed to alpha=0. Everything else stays fully opaque. This means it's
   safe to run on files that mix a checker background with white card
   content in the same image (e.g. a flattened composition) — it will not
   punch holes in flat white cards or erase text.
3. Writes the cleaned PNGs back into the SVG in place (same file structure,
   just real alpha now) and saves a new file — it never overwrites your
   original.

WHAT THIS SCRIPT DOES NOT DO
- It does not crop/trim the canvas (excess empty margin). That's a
  separate, more visual/manual step — see crop_svg_canvas.py alongside
  this file for a semi-automated version of that.
- It won't help if the checker pixels are NOT neutral gray/white (e.g. a
  colored checker) — if that ever happens, adjust CHROMA_THRESHOLD below.

USAGE
    pip install pillow numpy scipy
    python3 fix_svg_transparency.py input.svg output.svg

    # Tune thresholds if a file is under- or over-cleaned:
    python3 fix_svg_transparency.py input.svg output.svg --chroma 6 --std 9

    # Process every .svg in a folder at once, writing "-fixed.svg" copies:
    python3 fix_svg_transparency.py --batch ./assets/
"""

import re
import sys
import base64
import argparse
import io
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import uniform_filter, label, binary_closing, binary_opening, gaussian_filter

IMAGE_TAG_RE = re.compile(
    r'(<image[^>]*xlink:href="data:image/png;base64,)([A-Za-z0-9+/=]+)("[^>]*>)'
)


def _checker_mask(arr, chroma, chroma_thresh, std_thresh, window):
    """Detects the textured checkerboard-pattern defect (big background
    layers exported with the transparency-indicator baked into the pixels)."""
    gray = arr.mean(axis=-1)
    mean = uniform_filter(gray, size=window)
    mean_sq = uniform_filter(gray ** 2, size=window)
    local_std = np.sqrt(np.clip(mean_sq - mean ** 2, 0, None))
    strength = np.clip((local_std - std_thresh) / max(std_thresh, 1), 0, 1)
    strength = np.where(chroma <= chroma_thresh, strength, 0)
    return strength  # 0..1, 1 = confidently checker


def _flat_border_mask(arr, border_tol, min_frac, max_frac):
    """Detects the OTHER defect: a solid flat color (often black, sometimes
    white) filling the area around a rounded/circular icon, where real
    transparency should be. Works by flood-filling inward from the image
    border wherever the color stays close to the border's own color."""
    h, w, _ = arr.shape
    border_pixels = np.concatenate([
        arr[0, :, :], arr[-1, :, :], arr[:, 0, :], arr[:, -1, :]
    ])
    ref_color = np.median(border_pixels, axis=0)

    dist = np.sqrt(((arr - ref_color) ** 2).sum(axis=-1))
    bg_like = dist <= border_tol

    labeled, n = label(bg_like)
    if n == 0:
        return np.zeros((h, w), dtype=bool)

    border_labels = set(labeled[0, :].tolist()) | set(labeled[-1, :].tolist()) \
        | set(labeled[:, 0].tolist()) | set(labeled[:, -1].tolist())
    border_labels.discard(0)

    mask = np.isin(labeled, list(border_labels))
    frac = mask.mean()
    if frac < min_frac or frac > max_frac:
        # Too small to be a real background, or too large (would wipe a
        # genuinely solid-colored image) — skip.
        return np.zeros((h, w), dtype=bool)
    return mask


def key_out_checker(png_bytes: bytes, chroma_thresh: float, std_thresh: float,
                     window: int, min_pixels: int,
                     border_tol: float = 18, border_min_frac: float = 0.05,
                     border_max_frac: float = 0.9):
    """Return re-encoded PNG bytes with background defects keyed to
    alpha=0, or None if this image doesn't look like it has either known
    defect (so the caller can leave it untouched)."""
    im = Image.open(io.BytesIO(png_bytes))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGB")
    has_alpha = im.mode == "RGBA"
    arr = np.array(im.convert("RGB")).astype(np.float32)
    if arr.size == 0 or arr.shape[0] * arr.shape[1] < min_pixels:
        return None

    chroma = arr.max(axis=-1) - arr.min(axis=-1)

    # Checkerboard cell size AND contrast both vary a lot between exports —
    # some are bold with fine small cells, some are extremely faint with
    # large cells (just a few units of brightness difference spread over
    # ~50px). Rather than assume either, sweep a range of window sizes
    # (matching different possible cell periods) and texture thresholds,
    # and keep whichever combination first finds a plausible amount of
    # checker. The chroma guard protects any real colored content (lines,
    # icons, text) at every step regardless of window/threshold.
    checker_strength = _checker_mask(arr, chroma, chroma_thresh, std_thresh, window)
    best_frac = (checker_strength > 0.5).mean()
    if best_frac < 0.15:
        # Try larger windows first: a window at least as big as the checker
        # cell period gives a clean, contiguous detection. A window smaller
        # than the period only lights up at cell edges (a thin grid of
        # false detections), so we prefer big-enough windows over small
        # ones whenever both technically clear the frac threshold.
        for w in (51, 35, 25, 15, window):
            for factor in (1.0, 0.66, 0.44, 0.28, 0.17, 0.1, 0.06, 0.035, 0.02):
                trial = _checker_mask(arr, chroma, chroma_thresh, std_thresh * factor, w)
                frac = (trial > 0.5).mean()
                if 0.15 <= frac <= 0.9:
                    checker_strength, best_frac = trial, frac
                    break
            if best_frac >= 0.15:
                break

    flat_bg_mask = _flat_border_mask(arr, border_tol, border_min_frac, border_max_frac)

    checker_frac = (checker_strength > 0.5).mean()
    flat_frac = flat_bg_mask.mean()
    if checker_frac < 0.02 and flat_frac == 0:
        return None  # neither defect detected — leave this image untouched

    if checker_frac >= 0.15:
        # Clean up small residual "holes" left inside an otherwise solid
        # checker region (common with very low-contrast checkers), without
        # touching real content — chroma protection is re-applied after.
        solid = checker_strength > 0.5
        solid = binary_closing(solid, structure=np.ones((5, 5)), iterations=2)
        # Remove stray isolated noise specks left in otherwise-solid content
        # areas (the inverse problem to holes in the background).
        content = binary_opening(~solid, structure=np.ones((3, 3)), iterations=1)
        solid = ~content
        soft = gaussian_filter(solid.astype(np.float32), sigma=1.0)
        checker_strength = np.where(chroma <= chroma_thresh, np.maximum(checker_strength, soft), 0)

    new_alpha = ((1 - checker_strength) * 255).astype(np.uint8)
    new_alpha[flat_bg_mask] = 0

    if has_alpha:
        orig_alpha = np.array(im.convert("RGBA"))[..., 3]
        new_alpha = np.minimum(new_alpha, orig_alpha)

    rgba = np.dstack([arr.astype(np.uint8), new_alpha])
    out = Image.fromarray(rgba, "RGBA")
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


def process_svg(in_path: Path, out_path: Path, chroma_thresh: float,
                 std_thresh: float, window: int, min_pixels: int) -> int:
    text = in_path.read_text(encoding="utf-8", errors="ignore")
    fixed_count = 0

    def repl(m: re.Match) -> str:
        nonlocal fixed_count
        prefix, b64, suffix = m.group(1), m.group(2), m.group(3)
        try:
            raw = base64.b64decode(b64)
        except Exception:
            return m.group(0)
        new_raw = key_out_checker(raw, chroma_thresh, std_thresh, window, min_pixels)
        if new_raw is None:
            return m.group(0)
        fixed_count += 1
        new_b64 = base64.b64encode(new_raw).decode()
        return prefix + new_b64 + suffix

    new_text = IMAGE_TAG_RE.sub(repl, text)
    out_path.write_text(new_text, encoding="utf-8")
    return fixed_count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?", help="input .svg file")
    ap.add_argument("output", nargs="?", help="output .svg file")
    ap.add_argument("--batch", help="folder: process every .svg inside it")
    ap.add_argument("--chroma", type=float, default=6,
                     help="max color-saturation to count as 'neutral' (default 6)")
    ap.add_argument("--std", type=float, default=9,
                     help="min local texture to count as 'checker-like' (default 9)")
    ap.add_argument("--window", type=int, default=9,
                     help="pixel window size for texture detection (default 9)")
    ap.add_argument("--min-pixels", type=int, default=4000,
                     help="skip images smaller than this (icons etc.), default 4000")
    args = ap.parse_args()

    if args.batch:
        folder = Path(args.batch)
        svgs = sorted(folder.glob("*.svg"))
        if not svgs:
            print(f"No .svg files found in {folder}")
            return
        for svg in svgs:
            out = svg.with_name(svg.stem + "-fixed.svg")
            n = process_svg(svg, out, args.chroma, args.std, args.window, args.min_pixels)
            print(f"{svg.name}: fixed {n} embedded image(s) -> {out.name}")
        return

    if not args.input or not args.output:
        ap.error("provide input and output paths, or use --batch <folder>")

    n = process_svg(Path(args.input), Path(args.output), args.chroma, args.std,
                     args.window, args.min_pixels)
    print(f"Fixed {n} embedded image(s). Wrote {args.output}")
    if n == 0:
        print("Note: no checker-like images were detected. If the file still "
              "shows a checkerboard, try lowering --std (e.g. --std 6) or "
              "raising --chroma slightly (e.g. --chroma 8) and re-run.")


if __name__ == "__main__":
    main()
