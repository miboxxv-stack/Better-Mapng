#!/usr/bin/env python3
"""
Generate services/beamngTerrainMaterialLibrary.js from a BeamNG install.

Harvests each official level's art/terrains/main.materials.json (0.39+), picks
the template for each MapNG semantic slot (same candidate matching the runtime
used against the old example_terrain.materials.json snapshot), and resolves
every detail/macro texture to its canonical /assets/... location:

  1. exact-path .link redirect shipped by that level,
  2. any level's .link redirect for the same basename (the game's own
     authoritative old->new mapping),
  3. a basename match under assets/materials/terrain/**,
  4. the manual SUBSTITUTIONS table below.

Base slots (*BaseTex / t_terrain_base*) are left as harvested — the exporter
overwrites all of them with the generated satellite base. Legacy pre-PBR fields
(top-level macroMap/normalMap/detailMap/baseTexture) are dropped: exports ship
a TerrainMaterialTextureSet, which makes the engine ignore them.

The script exits non-zero if any non-base /levels/ reference survives — the
generated library must be cross-level-free so TerrainCellMaterial never needs
a .link chain (it does not resolve them; verified in-game 2026-07-22).

Run from the repo root:  python3 scripts/build-terrain-material-library.py
Re-run after every BeamNG update, then run scripts/audit-official-paths.py.
"""
import glob
import json
import os
import re
import sys
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(REPO, "refs/beamng/content")
OUT = os.path.join(REPO, "services/beamngTerrainMaterialLibrary.js")

# Union of every biome's terrainLevelFallbacks chain (beamngBiomeCatalog.js).
LEVELS = [
    "italy", "Utah", "automation_test_track", "east_coast_usa",
    "hirochi_raceway", "Industrial", "johnson_valley", "jungle_rock_island",
    "small_island", "west_coast_usa", "gridmap_v2",
]

# Mirror of DEFAULT_TERRAIN_CANDIDATES in beamngBiomeCatalog.js.
SEMANTIC_CANDIDATES = {
    "Grass": ["Grass", "Grass2", "Grass3", "Grass4", "dirt_grass"],
    "DirtGrass": ["dirt_grass", "dirt_loose_dusty", "RockyDirt", "dirt_loose", "Dirt"],
    "Dirt": ["Dirt", "dirt_loose", "dirt_grass", "RockyDirt", "dirt_loose_dusty"],
    "BeachSand": ["BeachSand", "sand", "dirt_sandy"],
    "ROCK": ["ROCK", "Rock", "Rock_cliff", "dirt_rocky", "dirt_rocky_large", "rockydirt", "rocks_large"],
    "asphalt": ["asphalt", "asphalt2", "groundmodel_asphalt1", "GROUNDMODEL_ASPHALT1"],
    "GRAVEL": ["GRAVEL", "gravel_wet", "dirt_rocky_large"],
    "Concrete": ["Concrete"],
}

# Level-local textures with no .link redirect anywhere and no basename match
# under assets/materials/terrain/**. Closest /assets equivalent, hand-picked.
SUBSTITUTIONS = {
    "t_grass1": "assets/materials/terrain/grass/t_grass_01/t_grass_01",
    "t_rock_eca": "assets/materials/terrain/rock/t_dirt_rocky/t_dirt_rocky",
    "t_rocks_pac": "assets/materials/terrain/rock/macro_rocky/t_macro_rocky",
    "t_italy_rock": "assets/materials/terrain/rock/t_dirt_rocky/t_dirt_rocky",
    "t_rock": "assets/materials/terrain/rock/t_dirt_rocky/t_dirt_rocky",
    "t_macro_cliff": "assets/materials/terrain/rock/macro_rocky/t_macro_rocky",
    "t_macro_grass2": "assets/materials/terrain/grass/macro_grass/t_macro_grass",
    "t_jri_grass": "assets/materials/terrain/grass/t_grass_02/t_grass_02",
    "t_jri_macro_grass": "assets/materials/terrain/grass/t_macro_grass/t_macro_grass",
    "t_dry_grass": "assets/materials/terrain/grass/t_dirt_dry_grass/t_dirt_dry_grass",
    "t_dry_grass_02": "assets/materials/terrain/grass/macro_dry_grass_02/t_macro_dry_grass_02",
    "t_buttercup_grass": "assets/materials/terrain/grass/t_grass_01/t_grass_01",
    "t_forest_floor": "assets/materials/terrain/forest/t_forest_ground/t_forest_ground",
    # jri_terrain_asphalt ships only .data/.color-suffixed dds without _h;
    # use the standard worn-asphalt set instead.
    "t_jri_asphalt": "assets/materials/terrain/asphalt/t_asphalt_02/t_asphalt_02",
    "t_concrete_gm": "assets/materials/terrain/concrete/concrete/t_concrete_damaged",
    "t_dirt_jri": "assets/materials/terrain/soil/t_dirt_sandy/t_dirt_sandy",
    "t_beachsand": "assets/materials/terrain/sand/t_sand/t_sand",
    "t_dirt_grass": "assets/materials/terrain/soil/t_dirt_dry_grassy/t_dirt_dry_grassy",
    "t_macro_concrete_tiled": "assets/materials/terrain/concrete/macro_concrete/t_macro_concrete",
    "t_dirt_loose": "assets/materials/terrain/soil/dirt_loose_dusty/t_dirt_loose_dusty",
}

LEGACY_FIELDS = {"macroMap", "normalMap", "detailMap", "baseTexture", "detailTex", "macroTex"}
STRIP_FIELDS = {"name", "persistentId"}
TEX_FIELD = re.compile(r"(Tex|Map)$")
IMG_EXT = re.compile(r"\.(png|dds|jpg)$", re.I)


def lc(s):
    return s.lower()


def load_game():
    """Return (index, link_targets, file_bytes_reader)."""
    zips = (glob.glob(os.path.join(CONTENT, "levels/*.zip"))
            + glob.glob(os.path.join(CONTENT, "assets/*.zip"))
            + glob.glob(os.path.join(CONTENT, "assets/materials/*.zip")))
    idx = {}          # lowercase path -> (zip, original name)
    links = {}        # lowercase path (without .link) -> lowercase target
    for z in zips:
        with zipfile.ZipFile(z) as zf:
            for n in zf.namelist():
                idx[lc(n)] = (z, n)
    for lp, (z, n) in list(idx.items()):
        if not lp.endswith(".link"):
            continue
        try:
            with zipfile.ZipFile(z) as zf:
                target = json.loads(zf.read(n)).get("path", "")
        except Exception:
            continue
        if target:
            links[lp[:-5]] = lc(target.lstrip("/"))
    return idx, links


def basename_map(links, idx):
    """basename (no variant suffix dir) -> /assets dir+stem, from all .link files."""
    m = {}
    for src, dst in links.items():
        if not dst.startswith("assets/materials/terrain/"):
            continue
        base = os.path.basename(src)
        stem = IMG_EXT.sub("", base)
        dst_stem = IMG_EXT.sub("", dst)
        m.setdefault(stem, dst_stem)
    # every real file under assets/materials/terrain also maps to itself
    for p in idx:
        if p.startswith("assets/materials/terrain/") and IMG_EXT.search(p):
            m.setdefault(IMG_EXT.sub("", os.path.basename(p)), IMG_EXT.sub("", p))
    return m


def resolve_texture(path, level, idx, links, base_map, unresolved):
    """Resolve one texture reference to a canonical /assets path (or keep base slots)."""
    rel = lc(path.lstrip("/"))
    stem_name = IMG_EXT.sub("", os.path.basename(rel))

    if "t_terrain_base" in rel:
        return path  # base slot; exporter overwrites it
    if rel.startswith("assets/"):
        if rel in idx or IMG_EXT.sub("", rel) + ".png" in idx or IMG_EXT.sub("", rel) + ".dds" in idx:
            return "/" + path.lstrip("/")
        unresolved.append((level, path, "missing /assets file"))
        return "/" + path.lstrip("/")
    # 1. exact .link shipped at this path
    if rel in links:
        return "/" + links[rel]
    # 2/3. basename lookup (game-wide links + real /assets terrain files)
    m = re.match(r"(.*)_(ao|b|h|nm|r|d|n|s|o)$", stem_name)
    prefix, suffix = (m.group(1), m.group(2)) if m else (stem_name, None)
    if prefix in SUBSTITUTIONS and suffix:
        return "/" + SUBSTITUTIONS[prefix] + "_" + suffix + ".png"
    if stem_name in base_map:
        return "/" + base_map[stem_name] + ".png"
    unresolved.append((level, path, "no /assets equivalent"))
    return path


def harvest_level(level, idx, links, base_map, unresolved):
    matpath = lc(f"levels/{level}/art/terrains/main.materials.json")
    if matpath not in idx:
        return None
    z, n = idx[matpath]
    with zipfile.ZipFile(z) as zf:
        mats = json.loads(zf.read(n))

    def matches(entry_key, tpl, candidate):
        names = {lc(str(x).strip()) for x in
                 [entry_key, tpl.get("name"), tpl.get("internalName"), tpl.get("mapTo")] if x}
        # harvested names look like "Grass-<uuid>"; match on the internalName part too
        return lc(candidate) in names

    resolved = {}
    for semantic, candidates in SEMANTIC_CANDIDATES.items():
        for cand in candidates:
            hit = None
            for key, tpl in mats.items():
                if not isinstance(tpl, dict) or tpl.get("class") != "TerrainMaterial":
                    continue
                if matches(key, tpl, cand):
                    hit = tpl
                    break
            if hit:
                out = {}
                for f, v in hit.items():
                    if f in STRIP_FIELDS or f in LEGACY_FIELDS:
                        continue
                    if isinstance(v, str) and TEX_FIELD.search(f) and re.search(r"\.(png|dds|jpg)$", v, re.I):
                        out[f] = resolve_texture(v, level, idx, links, base_map, unresolved)
                    else:
                        out[f] = v
                resolved[semantic] = out
                break
    return resolved or None


def main():
    if not os.path.isdir(CONTENT):
        print(f"No game install at {CONTENT}", file=sys.stderr)
        return 2
    idx, links = load_game()
    base_map = basename_map(links, idx)
    unresolved = []

    version = "unknown"
    m = re.search(r'"version"\s*:\s*"([^"]+)"',
                  open(os.path.join(REPO, "refs/beamng/integrity.json")).read())
    if m:
        version = m.group(1)

    library = {}
    for level in LEVELS:
        entry = harvest_level(level, idx, links, base_map, unresolved)
        if entry:
            library[lc(level)] = entry
            print(f"{level:24s} slots: {sorted(entry)}")
        else:
            print(f"{level:24s} NO TERRAIN MATERIALS")

    # purity check: no non-base /levels/ refs may survive
    leaks = []
    for level, slots in library.items():
        for semantic, tpl in slots.items():
            for f, v in tpl.items():
                if isinstance(v, str) and v.lstrip("/").lower().startswith("levels/") \
                        and "t_terrain_base" not in v.lower():
                    leaks.append((level, semantic, f, v))
    for leak in leaks:
        print("LEAK:", *leak, file=sys.stderr)
    for u in unresolved:
        print("UNRESOLVED:", *u, file=sys.stderr)
    if leaks or unresolved:
        return 1

    header = (
        "// GENERATED FILE — do not edit by hand.\n"
        f"// Built by scripts/build-terrain-material-library.py from BeamNG {version}.\n"
        "// Per-level TerrainMaterial templates for MapNG's semantic slots. All\n"
        "// detail/macro textures resolve to core /assets/... paths; base slots are\n"
        "// placeholders the exporter overwrites with the generated satellite base.\n"
        f"export const TERRAIN_MATERIAL_LIBRARY_VERSION = '{version}';\n\n"
        "export const TERRAIN_MATERIAL_LIBRARY = "
    )
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(header + json.dumps(library, indent=2, sort_keys=True) + ";\n")
    print(f"\nWrote {OUT} ({len(library)} levels, version {version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
