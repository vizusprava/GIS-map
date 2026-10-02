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
| `VITE_CESIUM_ION_TOKEN` | ne | jen pro Google Photorealistic 3D Tiles |

Bez ion tokenu appka funguje normálně — terén i ortofoto jedou přímo z ČÚZK,
neaktivní zůstanou jen Google 3D dlaždice.

### Databáze

Schéma je v `sql/001_init.sql`. Spustit **jednou** v SQL editoru Supabase projektu
(Dashboard → SQL Editor → New query). Skript je idempotentní, takže opakované
spuštění nic nerozbije. Vytvoří:

- `profiles` + trigger, který zakládá profil při registraci
- `geo_scenes` (scéna = zakázka) a `geo_assets` (nahrané soubory)
- tabulky bývalého editoru modelu (anotace, vegetace, materiály…) — appka je už nepoužívá,
  v databázi jen zůstávají
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
  MapView.tsx      mapa scény — spojuje hooky níž, obnovu scény, klik do mapy a boční panel
  use*.ts          jednotlivé části mapy: viewer, podklady a ořez, parcely, modely, výkresy,
                   dlaždice, měření, souřadnice, pohledy kamery, prezentace, exporty…
  panels/          sekce bočního panelu mapy
  toolColors.ts    barvy nástrojů (lišta, nápověda, sekce panelu i výběr v mapě) — mění se tady
  viewer-core/     geometrie řezu modelem (Three.js) — řez, pohled, výkres
  lib/             Supabase klient, scény, nahrané soubory, fronta ukládání
  pages/           přihlášení, přehled scén, otevřená scéna
  stores/          přihlášený uživatel (zustand)
sql/               migrace databáze
```

Persistence je do mapy **injektovaná** (`ScenePersist`), takže `MapView.tsx` o Supabase nic neví.

## Co se ukládá kam

| Kde | Co |
|---|---|
| **server** | vše, co patří ke scéně: nahrané soubory, usazení modelů, pohledy kamery, popisky, pulzy, měření, vybrané parcely a dlaždice, odečtené body a posun terénu, nastavení exportů, podklad, pozadí, poslední pozice kamery |
| **localStorage** | jen předvolby vázané na tenhle počítač: profil výkonu (auto / úsporný / kvalitní), ostrost renderu, výchozí hodnoty sliderů kroužení a chvění, rozbalené sekce panelu |
| **IndexedDB** | cache dlaždic ČÚZK a napečené ortofoto (`src/cache.ts`) — čistě výkonová věc, kdykoliv se dá smazat |

Ukládání je **automatické a odložené** — nic se nepotvrzuje tlačítkem. Tažení posuvníkem
se sloučí do jednoho zápisu, odchod ze scény a zavření okna rozpracovaný zápis dopíšou.

## Výkon

Mapa kreslí **jen na vyžádání** (Cesium `requestRenderMode`): v klidu grafika nepracuje. Kamera,
přelety a načítání dlaždic si snímek řeknou samy; cokoli jiného, co mění scénu mimo stav Reactu
(animace, entity přidané z časovače, tažení v nástrojích), musí zavolat `scene.requestRender()`.
Pojistky jsou v `useCesiumViewer.ts` (práce myší nad mapou, přidání nebo odebrání entity)
a na konci `MapView.tsx` (snímek po každém renderu). Když po změně obraz „zamrzne", chybí právě tohle.

Ortofoto i topografická mapa jedou z hotových dlaždicových cache ČÚZK (`ORTOFOTO_WM`, `ZTM_WM`),
ne přes WMS, který každou dlaždici renderuje na dotaz (~0,1 s proti ~1 s na dlaždici). Terén DMR 5G
se stahuje po blocích čtyř sousedních dlaždic jedním dotazem (`src/terrain.ts`). Na nově otevřeném
místě to dohromady zkrátilo načtení zhruba na polovinu, u detailu shora asi na třetinu.

Profil výkonu (`src/perfProfile.ts`) přepíná úsporný a kvalitní režim: rozlišení vykreslení,
vyhlazování, hustotu a cache dlaždic. „Auto" vybere
podle grafiky a paměti počítače.

## Poznámky a omezení

- Výšky: ČÚZK (DMR 5G, výkresy, exporty do Maxu) je v Bpv, Cesium i Google 3D dlaždice nad
  elipsoidem. Převod dělá kvazigeoid CR-2005 podle místa (`src/geoid.ts`, data © ČÚZK, CC BY 4.0) —
  v ČR je to 42,6–47,5 m, takže konstanta by terén posunula až o 3,5 m.
- Výkres **bez** S-JTSK souřadnic se usazuje do středu aktuálního pohledu, takže se po obnovení
  scény objeví jinde. U výkresů se souřadnicemi (běžný případ) sedí přesně.
- Nahrávání běží na pozadí: soubor je v mapě hned, upload dojíždí. Když selže, appka to řekne —
  soubor v mapě zůstane, ale po refreshi zmizí.
- Free tier Supabase má 1 GB storage. Modely a výkresy jsou velké — při reálném provozu počítej
  s placeným tarifem.
