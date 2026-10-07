/**
 * Obsah průvodce: kapitoly a jejich kroky. Tady se průvodce píše a upravuje — co se zvýrazní,
 * co se k tomu napíše a na co se čeká; vykreslení a krokování řeší `TourOverlay`.
 *
 * Krok:
 * - `target` — CSS selektor zvýrazněného místa (značky `data-tour`, `data-sec`, `data-minimap`);
 *   bez něj bublina uprostřed obrazovky; `prefer` — kam s bublinou nejdřív,
 * - `task` — „zkus to": krok pokračuje sám, až úkol platí (Další se změní na Přeskočit).
 *   Úkol, který platí už na začátku kroku, se nezadává — krok je pak jen ukázka,
 * - `before` — příprava (rozbalit panel nebo sekci, ať je na co ukázat),
 * - `when` — krok se přeskočí, když neplatí (scéna bez modelu, jen prohlížení…),
 * - `actions` — vlastní tlačítka místo Další (úklid ukázek).
 */
import type { ReactNode } from 'react'
import type * as Cesium from 'cesium'

/** Co průvodce potřebuje z mapy vědět a co v ní umí udělat (skládá MapView). */
export type TourCtx = {
  viewer: Cesium.Viewer | null
  /** jen prohlížení (sdílená scéna bez úprav, veřejný odkaz) */
  guest: boolean
  canShare: boolean
  /** klikací režim mapy — 'none' = žádný nástroj */
  tool: string
  rulers: { id: string; pts: number }[]
  parcelCount: number
  selectedModel: string | null
  modelCount: number
  drawingCount: number
  objectCount: number
  viewCount: number
  openPanel: () => void
  openSection: (id: string) => void
  removeRulers: (ids: string[]) => void
}

/** Stav ve chvíli, kdy krok (nebo kapitola) začal — úkoly porovnávají, co se od té doby změnilo. */
export type TourSnap = {
  /** kdy krok začal (performance.now) */
  at: number
  cam: { x: number; y: number; z: number; heading: number; pitch: number; height: number } | null
  rulerIds: Set<string>
  parcelCount: number
  viewCount: number
}

export type TourAction = { label: string; primary?: boolean; run: () => void }

export type TourStep = {
  id: string
  target?: string
  /** kam s bublinou nejdřív (třeba vedle hledání — pod ním se rozbalí výsledky) */
  prefer?: 'below' | 'above' | 'left' | 'right'
  title: string
  body: ReactNode
  task?: { label: string; done: (ctx: TourCtx, start: TourSnap) => boolean }
  before?: (ctx: TourCtx) => void
  when?: (ctx: TourCtx, chapterStart: TourSnap | null) => boolean
  actions?: (ctx: TourCtx, chapterStart: TourSnap | null) => TourAction[]
}

export type TourChapter = { id: string; title: string; summary: string; steps: TourStep[] }

export function snapOf(ctx: TourCtx): TourSnap {
  const v = ctx.viewer
  let cam: TourSnap['cam'] = null
  if (v && !v.isDestroyed()) {
    const p = v.camera.positionWC
    cam = { x: p.x, y: p.y, z: p.z, heading: v.camera.heading, pitch: v.camera.pitch, height: v.camera.positionCartographic.height }
  }
  return { at: performance.now(), cam, rulerIds: new Set(ctx.rulers.map(r => r.id)), parcelCount: ctx.parcelCount, viewCount: ctx.viewCount }
}

// Poslední stisk pravého tlačítka — úkol „přibliž pravým tlačítkem" se nesmí splnit kolečkem.
// Jeden posluchač na celou dobu, levný; bez něj by to musela hlásit kamera.
let lastRightDown = 0
if (typeof window !== 'undefined') window.addEventListener('pointerdown', e => { if (e.button === 2) lastRightDown = performance.now() }, true)

// ── pohyb kamery od začátku kroku ──
const camNow = (ctx: TourCtx) => snapOf(ctx).cam
const deg = (r: number) => (r * 180) / Math.PI
const angleDiff = (a: number, b: number) => Math.abs(((deg(a - b) + 540) % 360) - 180)
/** posun do strany: aspoň 10 m nebo 5 % výšky kamery */
const panned = (ctx: TourCtx, s: TourSnap) => {
  const c = camNow(ctx), o = s.cam
  if (!c || !o) return false
  const d = Math.hypot(c.x - o.x, c.y - o.y, c.z - o.z), dh = Math.abs(c.height - o.height)
  return Math.sqrt(Math.max(0, d * d - dh * dh)) > Math.max(10, 0.05 * o.height)
}
const zoomed = (ctx: TourCtx, s: TourSnap) => {
  const c = camNow(ctx), o = s.cam
  return !!c && !!o && Math.abs(c.height - o.height) > 0.15 * Math.max(o.height, 1)
}
const rightZoomed = (ctx: TourCtx, s: TourSnap) => lastRightDown > s.at && zoomed(ctx, s)
/** kamera nad Prahou (do 30 km od centra) — úkol z hledání místa */
const nearPrague = (ctx: TourCtx) => {
  const v = ctx.viewer
  if (!v || v.isDestroyed()) return false
  const c = v.camera.positionCartographic
  const lat = (c.latitude * 180) / Math.PI, lon = (c.longitude * 180) / Math.PI
  const km = Math.hypot((lat - 50.0755) * 111.2, (lon - 14.4378) * 111.2 * Math.cos((50.0755 * Math.PI) / 180))
  return km < 30 && c.height < 60_000
}
const turned = (ctx: TourCtx, s: TourSnap) => {
  const c = camNow(ctx), o = s.cam
  return !!c && !!o && (angleDiff(c.heading, o.heading) > 10 || angleDiff(c.pitch, o.pitch) > 8)
}
const newRulers = (ctx: TourCtx, s: TourSnap | null) => (s ? ctx.rulers.filter(r => !s.rulerIds.has(r.id)) : [])
const has = (sel: string) => !!document.querySelector(sel)

/** klávesa v textu */
function K({ children }: { children: ReactNode }) {
  return <kbd className="mx-0.5 rounded border border-gray-600 bg-gray-800 px-1 font-sans text-[11px] text-gray-200">{children}</kbd>
}

export const CHAPTERS: TourChapter[] = [
  {
    id: 'zaklady',
    title: 'Základy',
    summary: 'pohyb po mapě, hledání, minimapa, panel a lišta',
    steps: [
      {
        id: 'vitej',
        title: 'Vítej v mapě scény',
        body: <>Za pár minut ti ukážu, jak se tu pohybovat a kde co najdeš. U některých kroků tě nechám si to rovnou zkusit — stačí udělat, co je napsané, a průvodce pokračuje sám. Zavřít ho můžeš kdykoliv křížkem; vrátíš se k němu přes přehled zkratek (klávesa pod <K>Esc</K>) nebo v nastavení účtu.</>,
      },
      {
        id: 'posun',
        target: '[data-tour="mapa"]',
        title: 'Posun mapy',
        body: <>Chyť mapu levým tlačítkem myši a táhni — posuneš se po krajině.</>,
        task: { label: 'Posuň mapu tažením', done: panned },
      },
      {
        id: 'zoom',
        target: '[data-tour="mapa"]',
        title: 'Přiblížení kolečkem',
        body: <>Kolečkem myši přibližuješ a oddaluješ, a to k místu pod kurzorem.</>,
        task: { label: 'Přibliž nebo oddal mapu kolečkem', done: zoomed },
      },
      {
        id: 'prave-tlacitko',
        target: '[data-tour="mapa"]',
        title: 'Přiblížení pravým tlačítkem',
        body: <>Drž pravé tlačítko myši a táhni nahoru nebo dolů — přiblížíš nebo oddálíš plynule, bez skoků po zářezech kolečka. Hodí se na jemné doladění pohledu.</>,
        task: { label: 'Přibliž nebo oddal tažením s pravým tlačítkem', done: rightZoomed },
      },
      {
        id: 'naklon',
        target: '[data-tour="mapa"]',
        title: 'Náklon a otočení',
        body: <>Táhni se zmáčknutým kolečkem (prostředním tlačítkem) — pohled nakloníš a otočíš. Na touchpadu drž <K>Ctrl</K> a táhni. Klávesy <K>Q</K> a <K>E</K> otáčejí kamerou na místě, <K>Shift</K> + tah se rozhlédne.</>,
        task: { label: 'Nakloň nebo otoč pohled', done: turned },
      },
      {
        id: 'hledani',
        target: '[data-tour="hledani"]',
        prefer: 'right', // pod hledáním se rozbalí výsledky
        title: 'Hledání místa',
        body: <>Sem napíšeš obec, katastrální území, adresu nebo parcelu (třeba „95/1 Liberec"). Potvrď Enterem a v nabídce vyber, kam chceš — mapa tam přeletí. Vybrané území se zvýrazní; zrušíš ho křížkem v hledání. Terčík vedle vybere správní území klikem do mapy.</>,
        task: { label: 'Napiš „Praha", potvrď Enterem a vyber ji v nabídce', done: nearPrague },
      },
      {
        id: 'minimapa',
        target: '[data-tour="roh"]',
        title: 'Minimapa a kompas',
        body: <>Minimapa ukazuje, kde jsi a kam se díváš (modrý kužel). Klik do ní přenese kameru, tažením se otočíš a výšku nad terénem jde přepsat. Kompas pod ní vrátí pohled k severu. Klávesa <K>N</K> minimapu schová a zase ukáže.</>,
      },
      {
        id: 'panel',
        target: '[data-tour="panel"]',
        before: ctx => ctx.openPanel(),
        title: 'Panel',
        body: <>Vlevo je nastavení a obsah scény ve sbalovacích sekcích: podklad (ortofoto, topo, katastr), souřadnice, měření, import a seznam všeho ve scéně. Šipkou nahoře panel schováš, ať máš víc místa na mapu.</>,
      },
      {
        id: 'lista',
        target: '[data-tour="lista"]',
        title: 'Lišta nástrojů',
        body: <>Dole jsou nástroje po skupinách — najetím myší se nabídka otevře, klikem ji přišpendlíš. Zapnutý nástroj svítí svou barvou a stejnou barvou kreslí i do mapy, takže se hned pozná, co ke kterému nástroji patří.</>,
      },
      {
        id: 'zkratky',
        target: '[data-tour="zkratky"]',
        title: 'Klávesové zkratky',
        body: <>Skoro všechno má zkratku — písmeno vidíš v nabídkách u každé položky. Celý přehled otevře klávesa pod <K>Esc</K> (vlevo nahoře na klávesnici) nebo tohle tlačítko. V přehledu je i tlačítko, kterým průvodce kdykoliv spustíš znovu.</>,
        task: { label: 'Otevři přehled zkratek klávesou pod Esc', done: () => has('[data-tour="prehled-zkratek"]') },
      },
    ],
  },
  {
    id: 'nastroje',
    title: 'Nástroje',
    summary: 'výběr parcel, měření a souřadnice',
    steps: [
      {
        id: 'vyber',
        target: '[data-tour="lista-vyber"]',
        when: ctx => !ctx.guest,
        title: 'Výběr',
        body: <>Ve skupině Výběr vybíráš parcely z katastru (<K>P</K>), oblast obkreslením (<K>O</K>), čtvercové dlaždice (<K>D</K>) a správní území (<K>U</K>). Z výběru pak jdou exporty — hranice, výškopis, ortofoto.</>,
      },
      {
        id: 'parcela',
        target: '[data-tour="mapa"]',
        when: ctx => !ctx.guest,
        title: 'Zkus vybrat parcelu',
        body: <>Zapni výběr parcel klávesou <K>P</K> (nebo v nabídce Výběr) a klikni na pozemek v mapě. Parcela se obarví a objeví se v panelu i s výměrou.</>,
        task: { label: 'Vyber aspoň jednu parcelu', done: (ctx, s) => ctx.parcelCount > s.parcelCount },
      },
      {
        id: 'esc',
        target: '[data-tour="lista"]',
        title: 'Vypnutí nástroje',
        body: <>Klávesa <K>Esc</K> vypne zapnutý nástroj. Druhé <K>Esc</K> zruší i výběr (parcely, dlaždice…) — schválně na dvakrát, ať o výběr nepřijdeš omylem.</>,
        task: { label: 'Vypni nástroj klávesou Esc', done: ctx => ctx.tool === 'none' },
      },
      {
        id: 'mereni',
        target: '[data-tour="lista-nastroje"]',
        title: 'Měření',
        body: <>Vzdálenost měříš klávesou <K>M</K>, plochu <K>Shift</K>+<K>M</K>. Klikej body do mapy — chytají se i na 3D model nebo budovu, takže měření je opravdu ve 3D. Pravým tlačítkem měření ukončíš, klikem na první bod ho uzavřeš.</>,
        task: { label: 'Změř vzdálenost: M a dva body v mapě', done: (ctx, s) => newRulers(ctx, s).some(r => r.pts >= 2) },
      },
      {
        id: 'body',
        target: '[data-tour="mapa"]',
        title: 'Úprava měření',
        body: <>Body měření jde chytit a přetáhnout, i po modelu. Délky úseků, součet a převýšení se přepočítávají už během tažení.</>,
      },
      {
        id: 'seznam-mereni',
        target: '[data-sec="mereni"]',
        before: ctx => { ctx.openPanel(); ctx.openSection('mereni') },
        title: 'Seznam měření',
        body: <>V panelu jsou všechna měření scény — klikem vybereš, křížkem smažeš. Ukládají se do scény, takže je uvidí i ostatní.</>,
      },
      {
        id: 'souradnice',
        target: '[data-tour="lista-nastroje"]',
        when: ctx => !ctx.guest,
        title: 'Souřadnice bodu',
        body: <>Klávesa <K>S</K> a klik do mapy ukáže souřadnice v S-JTSK i WGS84 a výšku terénu. Body zůstanou v sekci Souřadnice a jdou zkopírovat.</>,
      },
      {
        id: 'uklid',
        when: (ctx, ch) => newRulers(ctx, ch).length > 0,
        title: 'Uklidit ukázky?',
        body: <>Během kapitoly vzniklo pár měření. Mám je smazat, nebo si je necháš? Výběr parcel zrušíš dvojím <K>Esc</K>.</>,
        actions: (ctx, ch) => [
          { label: 'Smazat ukázková měření', primary: true, run: () => ctx.removeRulers(newRulers(ctx, ch).map(r => r.id)) },
          { label: 'Nechat', run: () => {} },
        ],
      },
    ],
  },
  {
    id: 'modely',
    title: 'Modely a výkresy',
    summary: 'import, seznam scény, vzhled modelu a skrytí mapy',
    steps: [
      {
        id: 'import',
        target: '[data-sec="import"]',
        when: ctx => !ctx.guest,
        before: ctx => { ctx.openPanel(); ctx.openSection('import') },
        title: 'Import',
        body: <>Sem nahraješ 3D model (GLB, glTF nebo OBJ — třeba z 3ds Maxu), výkres (DWG, DXF) nebo vlastní ortofoto. Model se souřadnicemi v S-JTSK se usadí na své místo sám, jinak se objeví uprostřed pohledu. Soubory se ukládají do cloudu, nebo jen do tohoto počítače.</>,
      },
      {
        id: 'bez-modelu',
        when: ctx => ctx.modelCount === 0,
        title: 'Zatím bez modelu',
        body: <>Ve scéně zatím žádný model není. Až nějaký nahraješ, projdi si tuhle kapitolu znovu (přehled zkratek → Průvodce → Kapitoly) — ukáže ti, co s ním jde dělat.</>,
      },
      {
        id: 'scena',
        target: '[data-sec="scena"]',
        when: ctx => ctx.objectCount > 0,
        before: ctx => { ctx.openPanel(); ctx.openSection('scena') },
        title: 'Scéna',
        body: <>Seznam všeho ve scéně: modely, výkresy, parcely. Oko skryje, terčík zaměří, tužka přejmenuje. Šipka u modelu rozbalí jeho objekty (jak se jmenují v Maxu) s hledáním a přepínač vzhledu: textury, celý šedý, nebo každý objekt jinou barvou.</>,
      },
      {
        id: 'vyber-modelu',
        target: '[data-tour="mapa"]',
        when: ctx => ctx.modelCount > 0,
        title: 'Výběr modelu',
        body: <>Klikni na model v mapě (nebo na jeho řádek ve Scéně). Vybraný model rozsvítí v panelu svou sekci.</>,
        task: { label: 'Vyber model kliknutím', done: ctx => !!ctx.selectedModel },
      },
      {
        id: 'vybrany-model',
        target: '[data-sec="model"]',
        when: ctx => !!ctx.selectedModel && !ctx.guest,
        before: ctx => ctx.openPanel(),
        title: 'Vybraný model',
        body: <>Tady model posadíš na terén, skryješ mapu pod ním (terén i ortofoto se oříznou přesně podle půdorysu modelu) nebo zapneš svítící obrys. Pod „Usazení" je výška, otočení a měřítko; klávesou <K>V</K> model posuneš myší.</>,
      },
      {
        id: 'vykres',
        target: '[data-sec="scena"]',
        when: ctx => ctx.drawingCount > 0,
        before: ctx => { ctx.openPanel(); ctx.openSection('scena') },
        title: 'Výkresy',
        body: <>U výkresu rozbalíš hladiny — jde je hledat, vypínat a vybírat tažením přes víc řádků. Výkres jde přilepit na terén, zvednout a zprůhlednit.</>,
      },
    ],
  },
  {
    id: 'pohledy',
    title: 'Pohledy, prezentace, sdílení',
    summary: 'uložené pohledy kamery, prezentace a sdílení scény',
    steps: [
      {
        id: 'kamera',
        target: '[data-tour="lista-kamera"]',
        title: 'Uložené pohledy',
        body: <>V nabídce Kamera uložíš aktuální pohled a pojmenuješ ho. Mezi uloženými pohledy přepínáš šipkami <K>←</K> <K>→</K> a kamera k nim plynule přeletí. Je tu i vzhled kamery — ohnisko a rozostření.</>,
        task: { label: 'Ulož si aktuální pohled (nabídka Kamera)', done: (ctx, s) => ctx.viewCount > s.viewCount },
        when: ctx => !ctx.guest,
      },
      {
        id: 'perspektiva',
        target: '[data-tour="lista-pohled"]',
        title: 'Perspektiva a pohled shora',
        body: <>Přepíná perspektivu a pravoúhlý pohled shora (<K>T</K>) — shora se hodí na měření a kontrolu půdorysu. Je tu i vypínač minimapy.</>,
      },
      {
        id: 'prezentace',
        target: '[data-tour="lista-prezentace"]',
        title: 'Prezentace',
        body: <>Režim na předvádění: popisky v mapě, přelety mezi uloženými pohledy a obrazové efekty. Vypínač zapne nebo schová všechno najednou.</>,
      },
      {
        id: 'sdileni',
        target: '[data-share-open]',
        when: ctx => ctx.canShare,
        before: ctx => ctx.openPanel(),
        title: 'Sdílení',
        body: <>Pozvi kolegy e-mailem — můžou upravovat, nebo jen prohlížet. Pro lidi bez účtu jde vytvořit odkaz jen na prohlížení.</>,
      },
      {
        id: 'sceny',
        target: '[data-tour="sceny"]',
        before: ctx => ctx.openPanel(),
        title: 'Přehled scén',
        body: <>Tudy se vrátíš na přehled všech scén — s hledáním, řazením a scénami, které s tebou sdílí ostatní.</>,
      },
    ],
  },
]
