/**
 * Panel řezu modelem.
 *
 * Jen ovládání — všechen stav i výpočty drží `useSectionTool`, který sem chodí vcelku.
 * Seznam props je tím zároveň hranicí: co panel potřebuje navíc, je vidět na první pohled.
 */
import { Crosshair, Ruler, Eye, EyeOff, Move, ChevronLeft, ChevronRight, Check, Plus, Trash2, RotateCcw, Loader2 } from 'lucide-react'
import { NumRow } from '../ui'
import { fmtLen } from '../viewer-core/sectionCut'
import type { SectionTool } from '../useSectionTool'

export function SectionPanel({ sec, setMoveMode }: {
  sec: SectionTool
  setMoveMode: (on: boolean) => void
}) {
  return (
    <>
        <div className="flex gap-1.5">
          <button
            onClick={() => { setMoveMode(false); sec.setSecPick(p => (p === 'edge' ? null : 'edge')) }}
            title="Najedeš myší na model, čára se chytí na hranu a řez vznikne kolmo na ni"
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs ${sec.secPick === 'edge' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            <Crosshair size={13} /> Na hranu
          </button>
          <button
            onClick={() => { setMoveMode(false); sec.setSecPick(p => (p === 'line' ? null : 'line')) }}
            title="Dva kliky určí čáru řezu ručně"
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs ${sec.secPick === 'line' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            <Ruler size={13} /> Dva body
          </button>
          <button
            onClick={() => sec.setSecOn(o => !o)}
            disabled={!sec.secLine}
            title="Zapnout/vypnout ořez modelu"
            className={`px-2 py-1.5 rounded-lg text-xs disabled:opacity-40 ${sec.secOn ? 'bg-cyan-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            {sec.secOn ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        </div>
        {sec.secPick === 'line' && (
          <p className="text-[10px] text-cyan-300 leading-snug">
            Klikni dva body. Rovina jimi povede svisle. Klikat můžeš i přímo na model.
          </p>
        )}
        {sec.secPick === 'edge' && (
          <div className="flex flex-col gap-2 pl-1 border-l-2 border-cyan-700/50">
            <p className="text-[10px] text-cyan-300 leading-snug">
              {sec.secEdgeBusy
                ? 'Připravuji hrany modelu…'
                : 'Najeď myší na model. Čára se chytne na nejbližší hranu a řez vznikne kolmo na ni — klikem potvrdíš.'}
            </p>
            <NumRow label="Šířka řezu" value={sec.secLen > 0 ? sec.secLen : 20} min={1} max={500} step={1} unit="m" onChange={sec.setSecLen} />
          </div>
        )}
        {/* Uložené řezy — přepínají se jedním klikem a jdou i do databáze se scénou. */}
        {(sec.secSaved.length > 0 || sec.secLine) && (
          <div className="flex flex-col gap-1 rounded-lg border border-gray-800 p-1.5">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">
                Uložené řezy{sec.secSaved.length ? ' (' + sec.secSaved.length + ')' : ''}
              </span>
              {sec.secLine && (
                <button onClick={sec.saveSection} title="Uložit právě nastavený řez pod jménem"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-cyan-300 hover:bg-gray-800">
                  <Plus size={11} /> uložit
                </button>
              )}
            </div>
            {sec.secSaved.map(item => (
              <div
                key={item.id}
                className={`flex items-center gap-1 rounded-md px-1.5 py-1 ${sec.secActive === item.id ? 'bg-cyan-900/40' : 'hover:bg-gray-800/60'}`}
              >
                <button onClick={() => sec.loadSection(item)} className="flex min-w-0 flex-1 flex-col text-left">
                  <span className={`truncate text-[11px] ${sec.secActive === item.id ? 'text-cyan-200' : 'text-gray-300'}`}>{item.name}</span>
                  <span className="truncate font-mono text-[9px] text-gray-600">
                    {item.model} · {item.len > 0 ? fmtLen(item.len) : 'celý'}
                    {item.depth !== 0 ? ' · výřez ' + fmtLen(Math.abs(item.depth)) : ''}
                    {item.both ? ' · +kolmý' : ''}{item.plan ? ' · +půdorys' : ''}
                  </span>
                </button>
                <button onClick={() => sec.updateSection(item)} disabled={!sec.secLine}
                  title="Přepsat tímhle, co je právě nastavené"
                  className="shrink-0 rounded p-1 text-gray-600 hover:bg-gray-700 hover:text-white disabled:opacity-30">
                  <Check size={11} />
                </button>
                <button
                  onClick={() => {
                    sec.setSecSaved(list => list.filter(x => x.id !== item.id))
                    sec.setSecActive(a => (a === item.id ? null : a))
                  }}
                  title="Smazat uložený řez"
                  className="shrink-0 rounded p-1 text-gray-600 hover:bg-gray-700 hover:text-red-300"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            {!sec.secSaved.length && (
              <p className="px-1 pb-0.5 text-[10px] leading-snug text-gray-600">
                Připrav si řezů víc a přepínej mezi nimi. Ukládají se se scénou, takže tu budou i příště.
              </p>
            )}
          </div>
        )}

        {!sec.secLine && !sec.secPick && <p className="text-[10px] text-gray-500 leading-snug">„Na hranu“ se chytí na hranu modelu a řízne kolmo na ni. „Dva body“ nechá čáru na tobě.</p>}
        <p className="text-[10px] text-gray-500 leading-snug">Řeže výhradně vybraný 3D model. Terénu, ortofota ani Google dlaždic se nedotkne — na ty je „Řez terénem" v sekci výš.</p>

        {sec.secLine && (
          <>
            <button
              onClick={() => { setMoveMode(false); sec.setSecPick(p => (p === 'drag' ? null : 'drag')) }}
              title="Táhni v mapě za čáru celý řez, za její konec jen ten konec. Se Shiftem jde celá čára jen kolmo."
              className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs ${sec.secPick === 'drag' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
            >
              <Move size={13} /> {sec.secPick === 'drag' ? 'Tažení zapnuté' : 'Táhnout řez v mapě'}
            </button>
            {sec.secPick === 'drag' && (
              <p className="text-[10px] text-cyan-300 leading-snug">
                Za čáru táhneš celý řez, za puntík na konci jen ten konec (mění se i šířka řezu).
                Se Shiftem se čára posouvá jen kolmo na sebe. Escapem tažení vypneš.
              </p>
            )}

            <div className="flex items-center gap-1.5">
              <button onClick={() => sec.setSecOffset(o => o - sec.secStep)} title="Posunout proti normále"
                className="px-2 py-1.5 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700"><ChevronLeft size={13} /></button>
              <div className="flex-1 text-center text-[11px] font-mono text-gray-300">{sec.secOffset.toFixed(2)} m</div>
              <button onClick={() => sec.setSecOffset(o => o + sec.secStep)} title="Posunout po normále"
                className="px-2 py-1.5 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700"><ChevronRight size={13} /></button>
              <select value={sec.secStep} onChange={e => sec.setSecStep(Number(e.target.value))} title="Krok posunu"
                className="rounded-lg bg-gray-800 px-1 py-1.5 text-[10px] text-gray-300 outline-none">
                <option value={0.01}>1 cm</option>
                <option value={0.1}>10 cm</option>
                <option value={0.5}>50 cm</option>
                <option value={1}>1 m</option>
                <option value={5}>5 m</option>
              </select>
            </div>

            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
              <input type="checkbox" checked={sec.secFlip} onChange={e => sec.setSecFlip(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-500" />
              Odříznout druhou stranu
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
              <input type="checkbox" checked={sec.secClipMap} onChange={e => sec.setSecClipMap(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-500" />
              Ořezávat model i v mapě
            </label>
            {!sec.secClipMap && <p className="text-[10px] text-amber-300/80 leading-snug">Model zůstane v mapě celý; 2D výkres se počítá zvlášť a funguje dál.</p>}
            {sec.secClipMap && (
              <label className="flex items-center gap-2 pl-5 text-xs text-gray-300 cursor-pointer select-none">
                <input type="checkbox" checked={sec.secGhost} onChange={e => sec.setSecGhost(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-500" />
                Zbytek nechat průsvitný
              </label>
            )}

            {/* Hloubka výřezu — druhá mez, posunutá kopie roviny. Znaménko = na kterou stranu. */}
            <NumRow label="Hloubka výřezu (0 = bez)" value={sec.secDepth} min={-100} max={100} step={0.1} unit="m" onChange={sec.setSecDepth} />
            <p className="text-[10px] text-gray-500 leading-snug">
              Posune kopii roviny o zadanou vzdálenost. V mapě pak zůstane vidět <b>jen ten výřez</b>
              {' '}a do výkresu přijde jen to, co je mezi oběma rovinami. Záporná hodnota = na druhou stranu.
            </p>

            {/* Velikost řezu: přednastaví se na naklikaný úsek, 0 = skrz celý model */}
            <NumRow label="Délka řezu (0 = celý)" value={sec.secLen} min={0} max={5000} step={1} unit="m" onChange={sec.setSecLen} />
            <NumRow label="Výška řezu (0 = celý)" value={sec.secHeight} min={0} max={500} step={0.5} unit="m" onChange={sec.setSecHeight} />
            <p className="text-[10px] text-gray-500 leading-snug">
              Objekt, který rovina minula (sloupek zábradlí, svodidlo mezi řezy), se řízne vlastní rovinou
              skrz svůj střed a přidá se do výkresu celý. Kreslí se plnou čarou, ale do plochy hlavního
              řezu se nepočítá — leží jinde než rovina.
            </p>
            <div className={sec.secDepth !== 0 ? 'opacity-40' : undefined}>
              <NumRow label="Tloušťka řezu" value={sec.secThick} min={0} max={20} step={0.1} unit="m" onChange={sec.setSecThick} />
            </div>
            <p className="text-[10px] text-gray-500 leading-snug">
              {sec.secDepth !== 0
                ? 'Tloušťka se neuplatní — rozsah teď určuje „Hloubka výřezu“. Vynuluj ji, jestli chceš souměrný pás kolem roviny.'
                : 'Souměrný pás kolem roviny: prokládá se několika rovnoběžnými řezy a stejně se omezí i pohled.'}
            </p>
            {(sec.secLen > 0 || sec.secHeight > 0 || sec.secThick > 0 || sec.secDepth !== 0) && (
              <button onClick={() => { sec.setSecLen(0); sec.setSecHeight(0); sec.setSecThick(0); sec.setSecDepth(0) }} className="text-[10px] text-gray-500 hover:text-gray-300">
                zrušit omezení rozsahu
              </button>
            )}

            <button
              onClick={() => void sec.makeSectionDrawing()}
              disabled={sec.secBusy}
              className="flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs bg-cyan-700 text-white hover:bg-cyan-600 disabled:opacity-50"
            >
              {sec.secBusy ? <Loader2 size={13} className="animate-spin" /> : <Ruler size={13} />}
              {sec.secBusy ? 'Počítám řez…' : '2D výkres řezu'}
            </button>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
              <input type="checkbox" checked={sec.secViewLines} onChange={e => sec.setSecViewLines(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-500" />
              Obrysy pohledu (kótovatelné)
            </label>
            {sec.secViewLines && (
              <>
                <label className="flex items-center gap-2 pl-5 text-xs text-gray-300 cursor-pointer select-none">
                  <input type="checkbox" checked={sec.secOcclusion} onChange={e => sec.setSecOcclusion(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-500" />
                  Řešit zakrytí (skryté čáry čárkovaně)
                </label>
                <label className="flex items-center gap-2 pl-5 text-xs text-gray-400">
                  <span className="shrink-0">Detail obrysů</span>
                  <select
                    value={sec.secEdgeAngle}
                    onChange={e => sec.setSecEdgeAngle(Number(e.target.value))}
                    title="Od jakého úhlu se hrana považuje za zlomovou. Víc stupňů = míň čar a přehlednější výkres."
                    className="min-w-0 flex-1 rounded-md bg-gray-800 px-1.5 py-1 text-[11px] text-gray-200 outline-none"
                  >
                    <option value={20}>jemný — všechny hrany</option>
                    <option value={35}>normální</option>
                    <option value={50}>hrubý — jen výrazné</option>
                    <option value={65}>jen rohy</option>
                  </select>
                </label>
              </>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
              <input type="checkbox" checked={sec.secLive} onChange={e => sec.setSecLive(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-500" />
              Překreslovat otevřená okna živě
            </label>
            {sec.secLive && sec.secDrawings.length > 0 && (
              <p className="text-[10px] text-gray-500 leading-snug">
                {sec.secDragging
                  ? 'Táhneš — výkres jede nahrubo, po puštění se dopočítá naostro.'
                  : 'Posun řezu i změna rozsahu se hned promítnou do otevřených výkresů.'}
              </p>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
              <input type="checkbox" checked={sec.secPlan} onChange={e => sec.setSecPlan(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-500" />
              Spočítat i půdorys (shora)
            </label>
            {sec.secPlan && (
              <div className="pl-5">
                <NumRow label="Výška roviny" value={sec.secPlanZ} min={-50} max={50} step={0.1} unit="m" onChange={sec.setSecPlanZ} />
                <p className="text-[10px] leading-snug text-gray-500">
                  Nad středem čáry řezu. Vodorovná rovina se dívá dolů, takže je pod ní vidět celý výřez.
                </p>
              </div>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
              <input type="checkbox" checked={sec.secBoth} onChange={e => sec.setSecBoth(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-500" />
              Spočítat i kolmý řez
            </label>
            {sec.secBoth && (
              <p className="text-[10px] text-gray-500 leading-snug">
                Kolmý řez jde vždy přes celou konstrukci — „Délka řezu“ platí jen pro hlavní. Na podélný
                se hodí zvednout „Přibrat objekty z okolí“ (~2 m), ať se chytí i zábradlí po stranách.
              </p>
            )}
            {sec.secDrawings.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {sec.secDrawings.map(d => (
                  <button
                    key={d.key}
                    onClick={() => sec.setSecShown(s => { const n = new Set(s); if (n.has(d.key)) n.delete(d.key); else n.add(d.key); return n })}
                    title={sec.secShown.has(d.key) ? 'Zavřít okno výkresu' : 'Otevřít okno výkresu'}
                    className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] ${sec.secShown.has(d.key) ? 'bg-cyan-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                  >
                    {sec.secShown.has(d.key) ? <Eye size={12} /> : <EyeOff size={12} />} {d.label}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={sec.rotateSection90}
              title="Z příčného řezu udělá podélný a naopak — otočí rovinu o 90° kolem svislé osy ve stejném místě"
              className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs bg-gray-800 text-gray-200 hover:bg-gray-700"
            >
              <RotateCcw size={13} /> Otočit o 90° (příčný ↔ podélný)
            </button>
            <div className="text-[10px] text-gray-500 leading-snug">
              {sec.sectionSummary()}
            </div>
          </>
        )}
    </>
  )
}
