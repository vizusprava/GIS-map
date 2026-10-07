/**
 * Přepínače funkcí, ion assety, klíče předvoleb prohlížeče a číselné konstanty scény.
 *
 * Pozor na rozdíl: co patří ke SCÉNĚ (pohledy kamery, popisky, usazení modelů, podklad) se
 * ukládá na server přes `ScenePersist`. V localStorage zůstávají jen předvolby vázané na TENHLE
 * POČÍTAČ — ostrost renderu a výchozí hodnoty sliderů — proto tu zbyly jen tři klíče.
 *
 * Všechno, co se ladí „jednou a pak už jen sem tam", je schválně na jednom místě — jinak se
 * magická čísla rozlezou po komponentě a při hledání „kde se to nastavuje" se prochází 5 tisíc
 * řádků. Nic tady nesmí importovat MapView ani jiný modul appky (kromě Cesia), aby to šlo
 * natáhnout odkudkoliv bez cyklu.
 */
import * as Cesium from 'cesium'

export const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined

// Zrušený export: fetch(...,{signal}) i naše ruční `throw` házejí DOMException s name 'AbortError'.
export const isAbortError = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

// ── Přepínače funkcí (skrýt, ne mazat) ─────────────────────────────────────────────
// Pro nasazení v task-manageru nepotřebujeme Google 3D, OSM budovy ani městské části Liberce.
// Vypnutím zmizí jen tlačítka; funkce (ensureGoogle/ensureOsm/toggleDistricts) v kódu zůstávají,
// takže se to kdykoliv vrátí přepnutím na true. Vše je líné → skryté tlačítko = nula výkonu.
// POZOR: ion token používá JEN Google 3D a OSM budovy. Když jsou oba false, token není potřeba
// (terén DMR i ortofoto jedou přímo z ČÚZK) → odpadá i celý problém s 401 na ion.
export const ENABLE_GOOGLE_3D = true
export const ENABLE_OSM_BUILDINGS = false
export const ENABLE_LIBEREC_DISTRICTS = false
export const NEEDS_ION = ENABLE_GOOGLE_3D || ENABLE_OSM_BUILDINGS
// Řez modelem (sekce „Řez modelem", 2D výkresy) — zatím odložený. Vypnutý se nespouští vůbec:
// sekce v panelu zmizí, `useSectionTool` nic nenaslouchá ani neukládá (uložené řezy ve scénách
// zůstanou, jak byly). Celý kód i testy geometrie (test:section) zůstávají — stačí přepnout na true.
export const ENABLE_MODEL_SECTION = false

// Google Photorealistic 3D Tiles streamované přes Cesium ion (stačí ion token, žádný Google klíč).
// Asset je nutné jednorázově přidat ve svém ion účtu (Asset Depot → Google Photorealistic 3D Tiles).
export const GOOGLE_3D_ION_ASSET = 2275207

export const SHARP_KEY = 'geo.ostrost'      // supersampling nad rámec fyzických pixelů displeje
export const SPIN_KEY = 'geo.kamera.krouzeni' // { speed } — jen výchozí rychlost slideru;
                                              // zapnutí kroužení patří uloženému pohledu (CamLook)
export const SPIN_DEFAULT_DEG_S = 1           // °/s — jedna otáčka za 6 min, pomalý filmový drift
export const SHAKE_KEY = 'geo.kamera.handheld' // { amt } — jen výchozí intenzita slideru;
                                              // zapnutí chvění patří uloženému pohledu (CamLook)
export const SHAKE_MAX_DEG = 1.1             // výchylka pohledu při intenzitě 100 % (pořád jen plutí, ne třas)
// Plynulé přiblížení kolečkem
export const ZOOM_SENS = 0.0013              // log jednotek na pixel kolečka (~12 % na jeden zářez)
export const ZOOM_TAU = 0.22                 // měkkost pružiny v s — vyšší = delší, měkčí doklouznutí
export const ZOOM_MAX = 1.5                  // strop nedojetého zoomu (~4,5×), ať rychlé rolování neodletí

// Hromadný výběr dlaždic (oblastí nebo územím). Vykreslování je dávkové, takže tisíce dlaždic
// scéna unese — strop je tu jen proti překliku a proti zamrznutí na stavbě geometrie.
export const AREA_TILES_MAX = 20000
// Nad tímhle se radši zeptáme: kraj po 250 m je desítky tisíc dlaždic a při exportu i stažení.
export const AREA_TILES_CONFIRM = 2000

// ── Kvalita za pohybu ───────────────────────────────────────────────────────────
// Dokud se s mapou hýbe, nemá cenu dotahovat detail, který stejně proletí přes obraz — a přitom
// se kvůli němu stahují a dekódují dlaždice, tedy to, na co appka čeká nejvíc. V klidu se detail
// vrátí. Rozdíl mezi 8 a 16 je zhruba ČTYŘNÁSOBEK počtu dlaždic.
// Hodnoty pro kvalitní profil; úsporný si je zhrubí sám (perfProfile.ts).
export const GOOGLE_SSE_STILL = 8     // v klidu: víc detailu dřív
export const GOOGLE_SSE_MOVING = 16   // za pohybu: výchozí hodnota Cesia

/**
 * Povolená chyba dlaždic glóbu v pixelech — pro každý podklad jiná.
 *
 * Tohle rozhoduje, jakou úroveň pyramidy Cesium vybere pro kterou dlaždici, a vybírá ji
 * podle VZDÁLENOSTI od kamery. Zhora je všechno stejně daleko a mapa je jednolitá; jakmile
 * se pohled nakloní, je blízký okraj třeba třikrát blíž než vzdálený, takže na sebe na
 * obrazovce narazí dvě různé úrovně. Půlka chyby = dlaždice o úroveň jemnější, a protože
 * blízký okraj stejně naráží na strop pyramidy, rozdíl se tím o úroveň smrskne.
 *
 * Proč to není stejné číslo pro obojí: rozpůlení chyby znamená ČTYŘIKRÁT tolik dlaždic glóbu,
 * a s nimi i terénu, který se pod každou musí postavit. U topa to za to stojí, protože ZTM má
 * v každé úrovni JINOU KARTOGRAFII (jinde vrstevnice, jiné popisky), takže je předěl vidět jako
 * rovná hrana napříč mapou. U ortofota se úrovně liší jen měkkostí, žádná hrana tam není.
 *
 * Ostrost ortofota se proto neřeší tady, ale levněji v imagery.ts (`ORTO_TILE_PX`): ortofoto
 * sáhne o úroveň hloub, aniž by přibyly dlaždice glóbu a terénu. (Dřív šlo ortofoto přes WMS
 * po 435 kB na dlaždici a jemnější úroveň by načítání položila; z cache má dlaždice ~35 kB.)
 *
 * Úplně srovnat to při nakloněné kameře nejde ani u topa: jediné, co by dalo jednu úroveň
 * přes celou obrazovku, je stáhnout i blízký okraj na tu vzdálenou, tedy rozmazat popředí.
 * Od toho je tlačítko „Shora", kde je všechno stejně daleko z podstaty věci.
 *
 * Tohle jsou hodnoty kvalitního profilu; úsporný jde o stupeň hruběji (perfProfile.ts).
 */
export const GLOBE_SSE_PHOTO = 2  // ortofoto a 3D realita: výchozí hodnota Cesia
export const GLOBE_SSE_TOPO = 1   // topo: jemněji, ať se na obrazovce nesejdou dvě kartografie
export const MOVE_SETTLE_MS = 400     // jak dlouho po puštění se čeká, než se kvalita vrátí

// Náhled uloženého pohledu. Leží přímo ve stavu scény (viz CamView.thumb), a ten se ukládá celý
// naráz — proto tak malý. 160×90 se v seznamu pozná, JPEG na 0,5 vyjde na ~2 kB.
export const VIEW_THUMB_W = 160
export const VIEW_THUMB_H = 90
export const VIEW_THUMB_Q = 0.5
// Kdy hlásit „upraveno": o kolik se musí kamera odchýlit od uloženého pohledu, aby to nebyl
// jen numerický šum z přeletu. Metry pro pozici, stupně pro natočení.
export const VIEW_DIRTY_M = 1
export const VIEW_DIRTY_DEG = 0.5

export const CR_EXTENT = Cesium.Rectangle.fromDegrees(12.0, 48.5, 18.9, 51.1)
// úvodní pohled: přiblížení na Liberec
export const LIBEREC_EXTENT = Cesium.Rectangle.fromDegrees(14.98, 50.72, 15.13, 50.81)
// Převod výšek Bpv ↔ elipsoid je podle místa v `geoid.ts` (kvazigeoid ČÚZK CR-2005).
// 3ds Max při exportu glb otočí model o 90° kolem svislé osy — při kotveném importu kompenzujeme
export const MAX_GLB_YAW_DEG = 90
// OSM budovy posunout o 1 m dolů, ať lépe sedí na terén
export const OSM_LIFT_M = -1.5
// svítící obrys kolem importovaného modelu (glow) + barva hrany řezu terénem
export const MODEL_GLOW = Cesium.Color.fromCssColorString('#38f8ff')

export const EMPTY_NAMESET: ReadonlySet<string> = new Set()
