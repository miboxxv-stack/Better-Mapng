#!/usr/bin/env python3
"""
Audit every official BeamNG asset path the exporter references against a real
game install.

Collects all `/levels/...` and `/assets/...` file references from the export
catalogs, then checks each against the zips in refs/beamng/content. A path
counts as present when the exact file exists, a .png/.dds/.jpg sibling exists
(the engine resolves those interchangeably), or a `.link` redirect provides it.

Run from the repo root with a game install present under refs/beamng:

  python3 scripts/audit-official-paths.py

Exit code is the number of missing paths, so it can gate CI or a pre-release
check. Re-run after every BeamNG update — 0.37 moved shared textures into
/assets/, 0.39 renamed the ecusa grass + italy water sets; this script is how
those breaks get caught before users file "texture not found" reports.
"""
import glob
import json
import os
import re
import sys
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(REPO, "refs/beamng/content")

# Every module that embeds official asset paths in export output.
SOURCES = [
    "services/osmTerrainMaterials.js",
    "services/beamngTerrainMaterialLibrary.js",
    "services/beamngBiomeCatalog.js",
    "services/beamngRuntimeMaterialCatalog.js",
    "services/beamngFuelStationMaterials.js",
    "services/beamngSignals.js",
    "services/exportBeamNGLevel.js",
    "public/beamng_shape_materials.json",
]

# Textures the game itself references but does not ship (verified dangling in
# vanilla levels too). Matching vanilla is deliberate; do not report these.
KNOWN_VANILLA_DANGLING = {
    "/assets/materials/tree/beech/m_beech_merged_foliage/t_beech_merged_foliage_d.color.png",
    "/assets/materials/tree/beech/m_beech_merged_foliage/t_beech_merged_foliage_nm.normal.png",
    # official jungle vegetation_palm_bark_01 def ships this dead ref itself
    "/levels/jungle_rock_island/art/shapes/trees/trees_palm/vegetation_palm_bark_overlay_basecolor.png",
}

PATH_RE = re.compile(
    r"['\"](/?(?:levels|assets)/[^'\"]+\.(?:png|dds|jpg|dae|cdae))['\"]", re.I
)
IMG_EXT_RE = re.compile(r"\.(png|dds|jpg)$", re.I)


def collect_referenced_paths():
    refs = set()
    for src in SOURCES:
        with open(os.path.join(REPO, src), encoding="utf-8") as f:
            refs.update(m.group(1) for m in PATH_RE.finditer(f.read()))
    return sorted(refs)


def game_zips():
    return (
        glob.glob(os.path.join(CONTENT, "levels/*.zip"))
        + glob.glob(os.path.join(CONTENT, "assets/*.zip"))
        + glob.glob(os.path.join(CONTENT, "assets/materials/*.zip"))
        + [os.path.join(CONTENT, "art_shapes.zip")]
    )


def build_game_index():
    idx = set()
    for z in game_zips():
        with zipfile.ZipFile(z) as zf:
            idx.update(n.lower() for n in zf.namelist())
    return idx


def audit_dae_material_coverage(zips):
    """Every material a placed .dae binds must be defined by our export.

    Undefined materials fall back to the collada's embedded info, which
    resolves textures relative to the shape's (link-mirrored) folder — the
    'tro_tree_leaves_filler' NO-TEXTURE bug from the 2026-07-22 jungle test.
    Defined names come from the runtime catalogs plus the per-asset-set shape
    library; the official level's own materials.json is NOT loaded in-game.
    """
    catalog = open(os.path.join(REPO, "services/beamngBiomeCatalog.js")).read()
    daes = sorted(set(re.findall(r"shapeFile:\s*'([^']+\.(?:dae|cdae))'", catalog)))
    # lowercase throughout: BeamNG material lookup is case-insensitive
    defined = set()
    for src in ("services/beamngRuntimeMaterialCatalog.js", "services/beamngSignals.js",
                "services/beamngFuelStationMaterials.js"):
        defined |= {m.lower() for m in re.findall(r"(?:name|mapTo):\s*'([^']+)'",
                                                  open(os.path.join(REPO, src)).read())}
    shape_lib = json.load(open(os.path.join(REPO, "public/beamng_shape_materials.json")))
    for mats in shape_lib.values():
        for k, v in (mats or {}).items():
            defined.add(k.lower())
            if isinstance(v, dict) and v.get("mapTo"):
                defined.add(v["mapTo"].lower())

    entries = {}
    for z in zips:
        with zipfile.ZipFile(z) as zf:
            for n in zf.namelist():
                entries.setdefault(n.lower(), (z, n))

    gaps = []
    for dae in daes:
        rel = dae.lstrip("/").lower()
        if rel not in entries:
            gaps.append((dae, "<dae not found in game>"))
            continue
        z, n = entries[rel]
        with zipfile.ZipFile(z) as zf:
            xml = zf.read(n).decode("utf-8", "replace")
        used = set(re.findall(r'<instance_material\s+symbol="([^"]+)"', xml))
        used |= {m.split("#")[-1] for m in re.findall(r'<instance_material[^>]*target="([^"]+)"', xml)}
        used = {re.sub(r"-material$", "", u).lower() for u in used}
        for name in sorted(used - defined):
            gaps.append((dae, name))
    return gaps


def main():
    if not os.path.isdir(CONTENT):
        print(f"No game install at {CONTENT}; nothing to audit.", file=sys.stderr)
        return 2

    refs = collect_referenced_paths()
    idx = build_game_index()
    stems = {IMG_EXT_RE.sub("", n) for n in idx}
    stems |= {IMG_EXT_RE.sub("", n[:-5]) for n in idx if n.endswith(".link")}

    missing = []
    for p in refs:
        rel = p.lstrip("/").lower()
        if rel in idx or IMG_EXT_RE.sub("", rel) in stems:
            continue
        if p in KNOWN_VANILLA_DANGLING or "/" + p.lstrip("/") in KNOWN_VANILLA_DANGLING:
            continue
        missing.append(p)

    version = "unknown"
    integrity = os.path.join(REPO, "refs/beamng/integrity.json")
    if os.path.exists(integrity):
        m = re.search(r'"version"\s*:\s*"([^"]+)"', open(integrity).read())
        if m:
            version = m.group(1)

    gaps = audit_dae_material_coverage(game_zips())

    print(f"Game version: {version}")
    print(f"Referenced official paths: {len(refs)}")
    print(f"Missing: {len(missing)}")
    for p in missing:
        print(f"  {p}")
    print(f"Undefined dae-bound materials: {len(gaps)}")
    for dae, name in gaps:
        print(f"  {dae} -> {name}")
    return len(missing) + len(gaps)


if __name__ == "__main__":
    sys.exit(main())
