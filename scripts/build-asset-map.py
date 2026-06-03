#!/usr/bin/env python3
"""
Build the BeamNG level→assets migration map from a game install.

BeamNG 0.37 moved most shared textures from per-level folders into a central
/assets/ folder. Each level still ships a `*.link` file at the old path that
redirects to the new /assets/ location. Those .link files ARE the authoritative
old→new mapping. This script harvests them from every level zip and writes:

  - docs/asset-map.json         full ground-truth map (every .link redirect)
  - reports the subset our exporter actually references (for the migration)

Run from the repo root with a game install present under refs/beamng:

  python3 scripts/build-asset-map.py

Re-run after a game update to refresh the map.
"""
import json
import os
import re
import sys
import zipfile
import glob
from collections import Counter

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEVELS_DIR = os.path.join(REPO, "refs/beamng/content/levels")
ASSETS_DIR = os.path.join(REPO, "refs/beamng/content/assets")
OUT_MAP = os.path.join(REPO, "docs/asset-map.json")

# Source files that may reference level-scoped textures.
EXPORTER_SOURCES = [
    "services/exportBeamNGLevel.js",
    "services/osmTerrainMaterials.js",
    "services/beamngRuntimeMaterialCatalog.js",
    "services/beamngBiomeCatalog.js",
]

LEVEL_TEX_RE = re.compile(r"/?levels/[A-Za-z0-9_]+/art/[^\"'\s]+\.(?:dds|png)")


def harvest_link_map():
    """old level-scoped path (leading slash) -> /assets redirect path."""
    link_map = {}
    per_level = {}
    for zp in sorted(glob.glob(os.path.join(LEVELS_DIR, "*.zip"))):
        name = os.path.basename(zp)
        count = 0
        try:
            with zipfile.ZipFile(zp) as z:
                for info in z.infolist():
                    if not info.filename.endswith(".link"):
                        continue
                    try:
                        obj = json.loads(z.read(info.filename))
                    except Exception:
                        continue
                    target = obj.get("path")
                    if not target:
                        continue
                    old = "/" + info.filename[: -len(".link")].lstrip("/")
                    link_map[old] = target
                    count += 1
        except Exception as e:  # noqa: BLE001
            print(f"  !! {name}: {e}", file=sys.stderr)
        per_level[name] = count
    return link_map, per_level


def level_zip_has(path_no_slash):
    """Is path a REAL file inside its level zip (always-shipped fallback)?"""
    lvl = path_no_slash.split("/")[1]
    zp = os.path.join(LEVELS_DIR, lvl + ".zip")
    if not os.path.exists(zp):
        return False
    with zipfile.ZipFile(zp) as z:
        names = set(n.lstrip("/") for n in z.namelist())
    return path_no_slash in names


def exporter_refs():
    refs = set()
    for f in EXPORTER_SOURCES:
        p = os.path.join(REPO, f)
        try:
            src = open(p, encoding="utf-8").read()
        except OSError:
            continue
        for m in LEVEL_TEX_RE.findall(src):
            refs.add("/" + m.lstrip("/"))
    return refs


def main():
    link_map, per_level = harvest_link_map()
    json.dump(link_map, open(OUT_MAP, "w"), indent=0, sort_keys=True)
    print(f"levels scanned: {len(per_level)}")
    print(f"total .link redirects: {sum(per_level.values())}")
    print(f"wrote {OUT_MAP} ({len(link_map)} entries)")

    refs = exporter_refs()
    resolved = {r: link_map[r] for r in refs if r in link_map}
    unresolved = sorted(refs - set(resolved))
    phys = [u for u in unresolved if level_zip_has(u.lstrip("/"))]
    missing = [u for u in unresolved if u not in phys]

    print("\nExporter texture references:")
    print(f"  total distinct: {len(refs)}")
    print(f"  [A] rewrite to /assets via map: {len(resolved)}")
    print(f"  [B] still a real file in level zip (valid as-is): {len(phys)}")
    print(f"  [C] unresolved (needs manual review): {len(missing)}")
    if missing:
        print("  unresolved sample:")
        for m in missing[:15]:
            print("   ", m)


if __name__ == "__main__":
    main()
