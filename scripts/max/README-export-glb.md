# Export modelu z 3ds Maxu do geo-studia (GLB)

## Nastavení exportu

**File → Export → glTF** (Real-Time Exporter):

- **Export glTF Binary (.glb)** zaškrtnuté — geometrie i textury v jednom souboru
- Export All, nebo jen vybrané objekty (menší soubor; cloud bere nejvýš 50 MB na soubor)
- Shell Materials: **Original Materials**; když textury předem napečeš (Bake to Texture),
  pak **Baked Materials**
- jednotky scény v metrech (Customize → Units Setup → System Unit Setup), skutečné
  souřadnice S-JTSK nechat v geometrii — geo-studio podle nich model samo usadí

## Materiály V-Ray → `vray-na-physical.ms`

Real-Time Exporter materiálům V-Ray nerozumí: zapíše místo nich černý „fallback Material"
a **textury vůbec nevyexportuje**. V geo-studiu je pak model celý šedý (černé materiály bez
textury appka kreslí šedě) a textura se nedá doplnit — v souboru prostě není.

Před exportem proto:

1. Scénu ulož (nebo pracuj na kopii).
2. **Scripting → Run Script…** → `vray-na-physical.ms` → potvrď dotaz.
   Materiály V-Ray se převedou na Physical Material jen s difuzní barvou a texturou
   (lesk, odrazy, bump se zahodí — geo-studio je stejně nepoužívá).
3. Exportuj do .glb.
4. **Ctrl+Z** vrátí materiály V-Ray zpátky.

Skript zvládne VRayMtl, VRayLightMtl, obaly (VRayBlendMtl, VRay2SidedMtl, VRayOverrideMtl,
VRayMtlWrapper) i Multi/Sub-Object; texturu najde i uvnitř zanořených map (Color Correction,
Composite…) a VRayBitmap převede na obyčejný Bitmap.

Kontrola: geo-studio při importu zjednoduší každý materiál na barevnou texturu, takže jestli
model po importu pořád nemá textury, v .glb žádné nejsou — pošli ho ke kontrole.
