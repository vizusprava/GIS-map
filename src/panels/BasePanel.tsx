/**
 * Sekce „Podklad a překryvy": podklad mapy, překryvy, pozadí scény a nastavení vykreslování.
 */
import * as Cesium from 'cesium'
import { Building2, Image, Layers, Loader2, Map as MapIcon, Sparkles } from 'lucide-react'
import { ENABLE_GOOGLE_3D, ENABLE_LIBEREC_DISTRICTS, ENABLE_OSM_BUILDINGS } from '../config'
import { BG_MODES } from '../background'
import { detectPerf, type PerfChoice, type PerfLevel } from '../perfProfile'
import type { OrtoDetail } from '../imagery'
import { ToggleBtn } from '../ui'
import type { MapLayers } from '../useMapLayers'
import type { DistrictsTool } from '../useDistricts'

export function BasePanel({ layers, districts, perfChoice, setPerfChoice, perfLevel, sharpness, setSharpness, ortoDetail, setOrtoDetail, viewerReady, viewerRef }: {
  layers: MapLayers
  districts: DistrictsTool
  perfChoice: PerfChoice
  setPerfChoice: (c: PerfChoice) => void
  perfLevel: PerfLevel
  sharpness: number
  setSharpness: (s: number) => void
  ortoDetail: OrtoDetail
  setOrtoDetail: (d: OrtoDetail) => void
  viewerReady: boolean
  viewerRef: React.RefObject<Cesium.Viewer | null>
}) {
  const {
    base, setBase, googleLoading, googleErr, googleAlpha, setGoogleAlpha, googleUnder, setGoogleUnder,
    katastrOn, setKatastrOn, osmOn, setOsmOn, osmLoading, bgMode, setBgMode, bgCustom, setBgCustom,
  } = layers
  const { districtsOn, districtsLoading, toggleDistricts } = districts
  return (
    <>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1">Podklad</div>
      <ToggleBtn active={base === 'ortofoto'} onClick={() => setBase('ortofoto')} icon={<Image size={15} />} label="Ortofoto ČR" />
      <ToggleBtn active={base === 'zm'} onClick={() => setBase('zm')} icon={<MapIcon size={15} />} label="Topografická mapa ČR" />
      {ENABLE_GOOGLE_3D && (
        <ToggleBtn active={base === 'google'} onClick={() => setBase('google')} icon={googleLoading ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />} label="3D realita (Google)" />
      )}
      {ENABLE_GOOGLE_3D && base === 'google' ? (
        <div className="flex flex-col gap-1 px-1 max-w-[190px]">
          <div className="text-[10px] text-gray-500 leading-snug">
            {googleErr ? <span className="text-amber-400">{googleErr}</span> : <>Fotorealistické 3D. Posuvníkem prosvítíš mapu pod ním.</>}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-400 w-9 shrink-0">3D</span>
            <input type="range" min={0} max={1} step={0.05} value={googleAlpha} onChange={e => setGoogleAlpha(parseFloat(e.target.value))} className="flex-1 min-w-0 accent-cyan-500" title="Průhlednost 3D reality — vlevo jen mapa, vpravo plná 3D" />
            <span className="text-[10px] text-gray-300 tabular-nums w-8">{Math.round(googleAlpha * 100)}%</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-400 w-9 shrink-0">Pod</span>
            <button onClick={() => setGoogleUnder('ortofoto')} className={`px-1.5 py-0.5 rounded text-[11px] ${googleUnder === 'ortofoto' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>ortofoto</button>
            <button onClick={() => setGoogleUnder('zm')} className={`px-1.5 py-0.5 rounded text-[11px] ${googleUnder === 'zm' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>topo</button>
            <button onClick={() => setGoogleUnder('none')} title="Čistě 3D bez podkladu (skryje glóbus)" className={`px-1.5 py-0.5 rounded text-[11px] ${googleUnder === 'none' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>nic</button>
          </div>
          <div className="h-px bg-gray-700 my-0.5" />
          <ToggleBtn active={katastrOn} onClick={() => setKatastrOn(v => !v)} icon={<Layers size={15} />} label="Katastr" />
        </div>
      ) : (
        <>
          <div className="h-px bg-gray-700 my-0.5" />
          <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1">Překryv</div>
          <ToggleBtn active={katastrOn} onClick={() => setKatastrOn(v => !v)} icon={<Layers size={15} />} label="Katastr" />
        </>
      )}
      {ENABLE_OSM_BUILDINGS && (
        <ToggleBtn active={osmOn} onClick={() => setOsmOn(v => !v)} icon={osmLoading ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />} label="Budovy (OSM)" />
      )}
      {ENABLE_LIBEREC_DISTRICTS && (
        <ToggleBtn active={districtsOn} onClick={toggleDistricts} icon={districtsLoading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} label="Městské části Liberce" />
      )}
      <div className="h-px bg-gray-700 my-0.5" />
      <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1">
        Pozadí <span className="normal-case tracking-normal text-gray-600">— {base === 'google' ? '3D realita' : 'mapa'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1 px-1 max-w-[190px]">
        {BG_MODES.map(m => (
          <button key={m.id} onClick={() => setBgMode(m.id)} title={m.title}
            className={`px-1.5 py-0.5 rounded text-[11px] ${bgMode === m.id ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>{m.label}</button>
        ))}
        {bgMode === 'vlastni' && (
          <input type="color" value={bgCustom} onChange={e => setBgCustom(e.target.value)} title="Barva pozadí"
            className="h-5 w-7 shrink-0 cursor-pointer rounded border border-gray-700 bg-transparent p-0" />
        )}
      </div>
      {/* Profil výkonu (perfProfile.ts). Patří k počítači, ne ke scéně — ukládá se v prohlížeči. */}
      <div className="flex flex-col gap-1 border-t border-gray-700 pt-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="shrink-0 text-gray-400">Výkon</span>
          <div className="ml-auto flex gap-1">
            {([
              ['auto', 'Auto', 'Vybere se podle počítače — integrovaná grafika nebo málo paměti dostane úsporný profil'],
              ['usporny', 'Úsporný', 'Pro slabší notebooky: vykreslení v CSS pixelech, levnější vyhlazování (FXAA), hrubší a méně předstahované dlaždice, menší cache'],
              ['kvalitni', 'Kvalitní', 'Plné rozlišení displeje, MSAA, nejjemnější dlaždice a velká cache — pro výkonnou grafiku'],
            ] as const).map(([id, label, title]) => (
              <button
                key={id}
                onClick={() => setPerfChoice(id)}
                title={title}
                className={`rounded px-1.5 py-0.5 text-[11px] ${perfChoice === id ? 'bg-teal-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >{label}</button>
            ))}
          </div>
        </div>
        <div className="px-1 text-[10px] leading-snug text-gray-600">
          {perfChoice === 'auto'
            ? (perfLevel === 'usporny'
              ? `Auto → úsporný: ${detectPerf().reasons.join(', ')}`
              : `Auto → kvalitní${detectPerf().gpu ? ` (${detectPerf().gpu})` : ''}`)
            : perfLevel === 'usporny' ? 'Šetří grafiku i paměť, obraz je o něco měkčí.' : 'Nejvyšší kvalita, nejvíc zatěžuje grafiku.'}
        </div>
      </div>
      {/* Detail ortofota — jak hluboko sahat do pyramidy ČÚZK (imagery.ts). Tohle je to, co dělá
          ortofoto ostřejší; převzorkování níž jen vyhlazuje hrany. */}
      <div className="flex flex-col gap-1 border-t border-gray-700 pt-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="shrink-0 text-gray-400">Detail ortofota</span>
          <div className="ml-auto flex gap-1">
            {([
              ['standard', 'Standardní', 'Ostré ortofoto za běžnou cenu — výchozí'],
              ['max', 'Maximální', 'O úroveň jemnější (až nativních ~20 cm na pixel). Asi 3× víc stahování a načítání trvá déle.'],
            ] as const).map(([id, label, title]) => (
              <button
                key={id}
                onClick={() => setOrtoDetail(id)}
                title={title}
                className={`rounded px-1.5 py-0.5 text-[11px] ${ortoDetail === id ? 'bg-teal-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >{label}</button>
            ))}
          </div>
        </div>
        {ortoDetail === 'max' && (
          <div className="px-1 text-[10px] leading-snug text-gray-600">Jemnější ortofoto za asi 3× víc stahování; mapa se dotahuje déle.</div>
        )}
      </div>
      {/* Vyhlazení hran — převzorkování nad základní rozlišení (kvalitní profil: pixely displeje,
          úsporný: CSS pixely). Dřív se jmenovalo „Ostrost obrazu", jenže ortofoto neostří — jen
          uklidní třepení jemné kresby a hran. */}
      <div className="flex flex-col gap-1 border-t border-gray-700 pt-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="shrink-0 text-gray-400" title="Převzorkování: scéna se vykreslí větší a zmenší se až na obrazovku. Ortofoto tím neostří — na to je Detail ortofota.">Vyhlazení hran</span>
          <div className="ml-auto flex gap-1">
            {[1, 1.5, 2].map(s => (
              <button
                key={s}
                onClick={() => setSharpness(s)}
                title={s === 1
                  ? (perfLevel === 'usporny' ? 'Bez převzorkování (úsporný profil kreslí v CSS pixelech) — nejrychlejší' : 'Nativní rozlišení displeje — nejrychlejší')
                  : `Scéna se vykreslí ${s}× větší a zmenší se až na obrazovku. Uklidní třepení jemné kresby v ortofotu, ale stojí ${(s * s).toFixed(2).replace('.', ',')}× víc pixelů.`}
                className={`rounded px-1.5 py-0.5 text-[11px] tabular-nums ${sharpness === s ? 'bg-teal-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >{String(s).replace('.', ',')}×</button>
            ))}
          </div>
        </div>
        <div className="px-1 text-[10px] leading-snug text-gray-600">
          {viewerReady && `Renderuje se ${viewerRef.current?.scene.canvas.width ?? 0}×${viewerRef.current?.scene.canvas.height ?? 0} px`}
          {viewerReady && (window.devicePixelRatio || 1) !== 1 && ` · displej ${Math.round((window.devicePixelRatio || 1) * 100)} %`}
        </div>
      </div>
    </>
  )
}
