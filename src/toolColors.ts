/**
 * Barvy nástrojů — JEDINÉ místo, kde se nastavují.
 *
 * Každý nástroj má jednu barvu a ta se drží všude, kde k němu něco patří: tlačítko v liště dole
 * a položka v její nabídce, nápověda nad lištou, sekce panelu, kterou si nástroj při zapnutí
 * rozbalí, i to, co nástroj kreslí do mapy (vybrané parcely, dlaždice, měření, body). Podle barvy
 * se pak hned pozná, co ke kterému nástroji patří.
 *
 * ── Jak barvu změnit ──
 * Přepsat jedno slovo v `TOOL_COLOR` na jinou barvu z `PALETTE`. Víc není potřeba — lišta,
 * panel i mapa si ji vezmou odsud. Chybí-li v paletě barva, kterou chceš, zkopíruj některý její
 * řádek, přejmenuj ho a ve třídách přepiš odstín (např. `cyan` → `pink`); `map` je barva v mapě.
 *
 * Třídy jsou v paletě vypsané celé schválně: Tailwind najde jen celé názvy tříd, z kousků
 * poskládané (`bg-${barva}-600`) by ve výsledném CSS chyběly.
 */

export type ToolId = 'parcel' | 'area' | 'tiles' | 'region' | 'ruler' | 'coords' | 'move' | 'model'

/** Nástroj → barva. Tady se barvy mění. */
export const TOOL_COLOR = {
  parcel: 'emerald', // Vybrat parcelu — vybrané parcely v mapě, sekce Parcely
  area: 'orange', //    Vybrat oblast — kreslený obrys, sekce Výběr v mapě
  tiles: 'cyan', //     Vybrat dlaždice — vybrané dlaždice a mřížka, sekce Dlaždice
  region: 'violet', //  Vybrat území — sekce Správní území (území samo je dané ztmavením okolí)
  ruler: 'amber', //    Měření vzdálenosti a plochy — čáry a kóty, sekce Měření
  coords: 'blue', //    Souřadnice bodu — odečtené body, sekce Souřadnice
  move: 'sky', //       Posun modelu — sekce Vybraný model
  model: 'sky', //      Vybraný model (klik na model) — jeho řádek ve Scéně, sekce Vybraný model a Řez
} satisfies Record<ToolId, ColorName>

type Swatch = {
  /** barva v mapě (obrysy, výplně, body) — CSS hex */
  map: string
  /** plné tlačítko: zapnutý nástroj v liště, hlavní akce nástroje, zapnutý čip */
  solid: string
  /** jemně podbarvené tlačítko zapnutého nástroje v panelu */
  soft: string
  /** text: zapnutá položka nabídky, ikona v hlavičce sekce, hodnoty */
  text: string
  /** rámeček nápovědy nad lištou */
  border: string
  /** sekce panelu, kterou nástroj drží: rámeček a podklad, nadpis, odznak s počtem */
  section: string
  title: string
  badge: string
}

const PALETTE = {
  emerald: {
    map: '#34d399',
    solid: 'bg-emerald-600 text-white hover:bg-emerald-500',
    soft: 'border border-emerald-500/40 bg-emerald-600/25 text-emerald-200',
    text: 'text-emerald-300',
    border: 'border-emerald-600/70',
    section: 'border-emerald-500/70 bg-emerald-950/40 ring-1 ring-emerald-500/30',
    title: 'text-emerald-100',
    badge: 'bg-emerald-600 text-white',
  },
  orange: {
    map: '#fb923c',
    solid: 'bg-orange-600 text-white hover:bg-orange-500',
    soft: 'border border-orange-500/40 bg-orange-600/25 text-orange-200',
    text: 'text-orange-300',
    border: 'border-orange-600/70',
    section: 'border-orange-500/70 bg-orange-950/40 ring-1 ring-orange-500/30',
    title: 'text-orange-100',
    badge: 'bg-orange-600 text-white',
  },
  cyan: {
    map: '#38f8ff',
    solid: 'bg-cyan-600 text-white hover:bg-cyan-500',
    soft: 'border border-cyan-500/40 bg-cyan-600/25 text-cyan-200',
    text: 'text-cyan-300',
    border: 'border-cyan-600/70',
    section: 'border-cyan-500/70 bg-cyan-950/40 ring-1 ring-cyan-500/30',
    title: 'text-cyan-100',
    badge: 'bg-cyan-600 text-white',
  },
  violet: {
    map: '#a78bfa',
    solid: 'bg-violet-600 text-white hover:bg-violet-500',
    soft: 'border border-violet-500/40 bg-violet-600/25 text-violet-200',
    text: 'text-violet-300',
    border: 'border-violet-600/70',
    section: 'border-violet-500/70 bg-violet-950/40 ring-1 ring-violet-500/30',
    title: 'text-violet-100',
    badge: 'bg-violet-600 text-white',
  },
  amber: {
    map: '#fbbf24',
    solid: 'bg-amber-600 text-white hover:bg-amber-500',
    soft: 'border border-amber-500/40 bg-amber-600/25 text-amber-200',
    text: 'text-amber-300',
    border: 'border-amber-600/70',
    section: 'border-amber-500/70 bg-amber-950/40 ring-1 ring-amber-500/30',
    title: 'text-amber-100',
    badge: 'bg-amber-600 text-white',
  },
  blue: {
    map: '#60a5fa',
    solid: 'bg-blue-600 text-white hover:bg-blue-500',
    soft: 'border border-blue-500/40 bg-blue-600/25 text-blue-200',
    text: 'text-blue-300',
    border: 'border-blue-600/70',
    section: 'border-blue-500/70 bg-blue-950/40 ring-1 ring-blue-500/30',
    title: 'text-blue-100',
    badge: 'bg-blue-600 text-white',
  },
  sky: {
    map: '#38bdf8',
    solid: 'bg-sky-600 text-white hover:bg-sky-500',
    soft: 'border border-sky-500/40 bg-sky-600/25 text-sky-200',
    text: 'text-sky-300',
    border: 'border-sky-600/70',
    section: 'border-sky-500/70 bg-sky-950/40 ring-1 ring-sky-500/30',
    title: 'text-sky-100',
    badge: 'bg-sky-600 text-white',
  },
  // ── další na výběr ──
  rose: {
    map: '#fb7185',
    solid: 'bg-rose-600 text-white hover:bg-rose-500',
    soft: 'border border-rose-500/40 bg-rose-600/25 text-rose-200',
    text: 'text-rose-300',
    border: 'border-rose-600/70',
    section: 'border-rose-500/70 bg-rose-950/40 ring-1 ring-rose-500/30',
    title: 'text-rose-100',
    badge: 'bg-rose-600 text-white',
  },
  lime: {
    map: '#a3e635',
    solid: 'bg-lime-600 text-white hover:bg-lime-500',
    soft: 'border border-lime-500/40 bg-lime-600/25 text-lime-200',
    text: 'text-lime-300',
    border: 'border-lime-600/70',
    section: 'border-lime-500/70 bg-lime-950/40 ring-1 ring-lime-500/30',
    title: 'text-lime-100',
    badge: 'bg-lime-600 text-white',
  },
  fuchsia: {
    map: '#e879f9',
    solid: 'bg-fuchsia-600 text-white hover:bg-fuchsia-500',
    soft: 'border border-fuchsia-500/40 bg-fuchsia-600/25 text-fuchsia-200',
    text: 'text-fuchsia-300',
    border: 'border-fuchsia-600/70',
    section: 'border-fuchsia-500/70 bg-fuchsia-950/40 ring-1 ring-fuchsia-500/30',
    title: 'text-fuchsia-100',
    badge: 'bg-fuchsia-600 text-white',
  },
  teal: {
    map: '#2dd4bf',
    solid: 'bg-teal-600 text-white hover:bg-teal-500',
    soft: 'border border-teal-500/40 bg-teal-600/25 text-teal-200',
    text: 'text-teal-300',
    border: 'border-teal-600/70',
    section: 'border-teal-500/70 bg-teal-950/40 ring-1 ring-teal-500/30',
    title: 'text-teal-100',
    badge: 'bg-teal-600 text-white',
  },
} satisfies Record<string, Swatch>

export type ColorName = keyof typeof PALETTE

/** Třídy a barva v mapě pro daný nástroj. */
export const toolTheme = (id: ToolId): Swatch => PALETTE[TOOL_COLOR[id]]
