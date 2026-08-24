# GIS Map

Webová aplikace pro usazování 3D modelů, výkresů (DXF/DWG) a georeferencovaných rastrů
do reálné mapy ČR — terén DMR 5G a ortofoto z ČÚZK, katastr, měření, export.
Každý uživatel má vlastní účet a svoje scény se vším, co do nich nahraje.

**Živá verze:** <https://vizusprava.github.io/GIS-map/>

## Rychlý start (lokálně)

```bash
npm install
cp .env.example .env.local   # a vyplnit hodnoty (viz níž)
npm run dev
```

## Nastavení

Do `.env.local` patří:

| Proměnná | Povinná | K čemu |
|---|---|---|
| `VITE_SUPABASE_URL` | ano | adresa Supabase projektu |
| `VITE_SUPABASE_ANON` | ano | publishable klíč (veřejný — chrání ho RLS, ne tajnost) |
| `VITE_CESIUM_ION_TOKEN` | ne | jen pro Google Photorealistic 3D Tiles a splat |

Bez ion tokenu appka funguje normálně — terén i ortofoto jedou přímo z ČÚZK,
neaktivní zůstanou jen Google 3D dlaždice.

### Databáze

Schéma je v `sql/001_init.sql`. Spustit **jednou** v SQL editoru Supabase projektu
(Dashboard → SQL Editor → New query). Skript je idempotentní, takže opakované
spuštění nic nerozbije. Vytvoří:

- `profiles` + trigger, který zakládá profil při registraci
- `geo_scenes` (scéna = zakázka) a `geo_assets` (nahrané soubory)
- tabulky 3D vieweru — anotace, vegetace, barvy objektů, pohledy kamery, materiály
- RLS na všem: každý vidí a mění jen svoje řádky
- privátní storage bucket `geo`; soubory se servírují přes dočasné signed URL

Po nasazení na veřejnou adresu je potřeba ji přidat v Supabase do
**Authentication → URL Configuration** (Site URL i Redirect URLs), jinak nebudou
fungovat odkazy z potvrzovacích a resetovacích e-mailů.

## Nasazení

Push do `main` spustí `.github/workflows/deploy.yml`, který postaví appku
a publikuje ji na GitHub Pages. Hodnoty z tabulky výš musí být uložené jako
**repository secrets** (Settings → Secrets and variables → Actions).

`base` je v `vite.config.ts` schválně **relativní** (`./`). Absolutní cesta by
rozbila Cesium: `vite-plugin-cesium` kopíruje podklady do `outDir + CESIUM_BASE_URL`,
takže by skončily jinde, než na ně odkazuje `index.html`. S `./` build funguje
v kořeni domény i v libovolné podcestě.

## Struktura

```
src/
  MapView.tsx      hlavní mapa (Cesium) — podklady, modely, výkresy, měření, export
  viewer-core/     3D viewer modelu (Three.js) — sdílené jádro, nezná úložiště
  lib/             Supabase klient, scény, nahrané soubory, adaptér vieweru
  pages/           přihlášení, přehled scén, otevřená scéna, editor modelu
  stores/          přihlášený uživatel (zustand)
sql/               migrace databáze
```

Persistence je do vieweru i mapy **injektovaná** (`ViewerAdapter`, `ScenePersist`),
takže `viewer-core/` ani `MapView.tsx` o Supabase nic nevědí.

## Co se ukládá kam

| Kde | Co |
|---|---|
| **server** | vše, co patří ke scéně: nahrané soubory, usazení modelů, pohledy kamery, popisky, pulzy, měření, vybrané parcely, podklad, pozadí, poslední pozice kamery |
| **localStorage** | jen předvolby vázané na tenhle počítač: ostrost renderu, výchozí hodnoty sliderů kroužení a chvění, rozbalené sekce panelu |
| **IndexedDB** | cache dlaždic ČÚZK a napečené ortofoto (`src/cache.ts`) — čistě výkonová věc, kdykoliv se dá smazat |

Ukládání je **automatické a odložené** — nic se nepotvrzuje tlačítkem. Tažení posuvníkem
se sloučí do jednoho zápisu, odchod ze scény a zavření okna rozpracovaný zápis dopíšou.

## Poznámky a omezení

- Výkres **bez** S-JTSK souřadnic se usazuje do středu aktuálního pohledu, takže se po obnovení
  scény objeví jinde. U výkresů se souřadnicemi (běžný případ) sedí přesně.
- Nahrávání běží na pozadí: soubor je v mapě hned, upload dojíždí. Když selže, appka to řekne —
  soubor v mapě zůstane, ale po refreshi zmizí.
- Editor modelu jde otevřít až po dokončení uploadu (do té doby není co načíst ze serveru).
- Free tier Supabase má 1 GB storage. Modely a výkresy jsou velké — při reálném provozu počítej
  s placeným tarifem.
