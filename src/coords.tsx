/**
 * Odečet souřadnic z mapy — pro přenos bodů do 3ds Maxu a SynthEyes.
 *
 * Vypisuje se S-JTSK (Křovák) a výška Bpv, tedy PŘESNĚ ta soustava, ve které vychází exportovaný
 * terén (`buildTileObj`: X/Y Křovák, Z Bpv). Kdyby se ukazovalo něco jiného, čísla z panelu by
 * s modelem v Maxu nešla porovnat a celé by to bylo k ničemu.
 *
 * POZOR na výšku: Cesium počítá nad elipsoidem a `makeDmrTerrain` k datům z ČÚZK přičítá GEOID_CZ.
 * Zpátky na Bpv se to musí odečíst — jinak by body seděly o 44 metrů výš.
 *
 * Posun terénu řeší druhá sada čísel. Terén se exportuje v reálných souřadnicích (statisíce metrů),
 * takže se v Maxu stejně musí posunout k počátku; tady se zadá o kolik a panel dopočítá souřadnice
 * v soustavě scény. Zadává se posun MODELU, takže se k odečtené hodnotě přičítá.
 */
import { Crosshair, Copy, Trash2, Target } from 'lucide-react'
import type { CoordPoint } from './lib/types'

type Props = {
  pts: CoordPoint[]
  shift: [number, number, number]
  onShift: (s: [number, number, number]) => void
  onDelete: (id: string) => void
  onClear: () => void
  onGoto: (p: CoordPoint) => void
  /** střed vybraných dlaždic — obvyklý posun, když se terén v Maxu dává k počátku */
  tileCenter: [number, number] | null
  picking: boolean
  onTogglePicking: () => void
}

const f2 = (n: number) => n.toFixed(2)

export function CoordsPanel(p: Props) {
  const [sx, sy, sz] = p.shift
  const shifted = (c: CoordPoint) => [c.x + sx, c.y + sy, c.z + sz] as const
  const copy = (t: string) => { void navigator.clipboard?.writeText(t) }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={p.onTogglePicking}
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors ${
          p.picking ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
        }`}
      >
        <Crosshair size={13} /> {p.picking ? 'Klikni do mapy…' : 'Odečíst bod'}
      </button>

      <div className="px-1 text-[10px] leading-snug text-gray-600">
        S-JTSK (EPSG:5514) a výška <span className="text-gray-400">Bpv</span> — stejná soustava,
        v jaké vychází exportovaný terén.
      </div>

      {/* ── posun terénu ── */}
      <div className="flex flex-col gap-1 rounded-lg bg-gray-800/50 p-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">Posun terénu</span>
          {p.tileCenter && (
            <button
              onClick={() => p.onShift([-p.tileCenter![0], -p.tileCenter![1], 0])}
              title="Posun, který dá střed vybraných dlaždic do počátku — to se v Maxu dělá nejčastěji"
              className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-cyan-300 hover:bg-gray-700"
            >
              <Target size={11} /> ze středu dlaždic
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(['X', 'Y', 'Z'] as const).map((lbl, i) => (
            <label key={lbl} className="flex min-w-0 flex-1 items-center gap-1">
              <span className="w-2.5 shrink-0 text-[10px] text-gray-500">{lbl}</span>
              <input
                type="number"
                value={p.shift[i]}
                onChange={e => {
                  const next: [number, number, number] = [...p.shift]
                  next[i] = Number(e.target.value) || 0
                  p.onShift(next)
                }}
                className="min-w-0 flex-1 rounded bg-gray-900 px-1 py-0.5 text-[11px] tabular-nums text-gray-100 outline-none"
              />
            </label>
          ))}
        </div>
        {(sx || sy || sz) ? (
          <button onClick={() => p.onShift([0, 0, 0])} className="self-start px-0.5 text-[10px] text-gray-500 hover:text-red-300">vynulovat posun</button>
        ) : (
          <div className="px-0.5 text-[10px] leading-snug text-gray-600">Nula = skutečné souřadnice.</div>
        )}
      </div>

      {p.pts.map((c, i) => {
        const [mx, my, mz] = shifted(c)
        const moved = !!(sx || sy || sz)
        return (
          <div key={c.id} className="flex flex-col gap-0.5 rounded-lg bg-gray-800/50 p-1.5">
            <div className="flex items-center gap-1">
              <button onClick={() => p.onGoto(c)} title="Přeletět na bod" className="min-w-0 flex-1 truncate text-left text-[11px] text-gray-300 hover:text-white">
                <span className="text-gray-600">{i + 1}.</span> {c.lat.toFixed(5)}, {c.lon.toFixed(5)}
              </button>
              <button onClick={() => copy(`${f2(mx)} ${f2(my)} ${f2(mz)}`)} title="Zkopírovat X Y Z (s posunem, pokud je zadaný)" className="shrink-0 rounded p-0.5 text-gray-500 hover:text-emerald-300"><Copy size={12} /></button>
              <button onClick={() => p.onDelete(c.id)} title="Smazat bod" className="shrink-0 rounded p-0.5 text-gray-500 hover:text-red-300"><Trash2 size={12} /></button>
            </div>
            <Row label="skutečné" x={c.x} y={c.y} z={c.z} dim={moved} />
            {moved && <Row label="po posunu" x={mx} y={my} z={mz} />}
          </div>
        )
      })}

      {p.pts.length > 1 && (
        <button onClick={p.onClear} className="self-start px-1 text-[10px] text-gray-500 hover:text-red-300">smazat všechny body</button>
      )}
      {!p.pts.length && (
        <div className="px-1 text-[10px] leading-snug text-gray-600">
          Zatím žádné. Zapni „Odečíst bod" a klikni do mapy — výška se dotáhne přímo z ČÚZK
          (DMR 5G), ze stejného zdroje, ze kterého se počítá export. Hotový bod jde chytit
          a přetáhnout jinam.
        </div>
      )}
    </div>
  )
}

function Row({ label, x, y, z, dim }: { label: string; x: number; y: number; z: number; dim?: boolean }) {
  return (
    <div className={`flex items-baseline gap-1.5 text-[11px] tabular-nums ${dim ? 'text-gray-500' : 'text-gray-200'}`}>
      <span className="w-14 shrink-0 text-[9px] uppercase tracking-wide text-gray-600">{label}</span>
      <span className="min-w-0 flex-1 truncate">{f2(x)} {f2(y)} {f2(z)}</span>
    </div>
  )
}
