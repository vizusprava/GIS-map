/**
 * Panel vzhledu kamery — hloubka ostrosti, zorný úhel, bloom.
 *
 * Jen ovládání; co se s tím děje ve scéně, drží `useLookTool`.
 */
import { ProjSwitch } from '../ui'
import type { CamProj } from '../ui'
import type { LookTool } from '../useLookTool'

export function LookPanel({
  look, camProj, camPerspective, camTopOrtho, presentOn,
  shakeOn, setShakeOn, shakeAmt, setShakeAmt, spinOn, setSpinOn, spinSpeed, setSpinSpeed,
}: {
  look: LookTool
  /**
   * Panel „Vzhled kamery" sahá dál než hook: kromě hloubky ostrosti a bloomu ovládá i projekci
   * a chování kamery při přeletu. Že je toho v props tolik, je poctivá informace — ta sekce
   * opravdu spojuje tři různé věci a je to místo, kde by se dalo pokračovat v úklidu.
   */
  camProj: CamProj
  camPerspective: () => void
  camTopOrtho: () => void
  presentOn: boolean
  shakeOn: boolean
  setShakeOn: (v: boolean) => void
  shakeAmt: number
  setShakeAmt: (v: number) => void
  spinOn: boolean
  setSpinOn: (v: boolean) => void
  spinSpeed: number
  setSpinSpeed: (v: number) => void
}) {
  return (
    <>
        <div className="px-1 text-[10px] leading-snug text-gray-500">
          Všechno tady se ukládá <span className="text-gray-400">s pohledem</span> — každý může vypadat jinak.
        </div>
        <ProjSwitch mode={camProj} onPersp={camPerspective} onOrtho={camTopOrtho} />
        {/* FOV — v ortho projekci nemá co dělat, tak je zhasnutý místo aby tiše nedělal nic */}
        <label className="flex items-center gap-1.5 text-xs border-t border-gray-700 pt-2">
          <span className="text-gray-400 w-16 shrink-0">Zorný úhel</span>
          <input
            type="range" min={20} max={100} step={1} value={look.fov}
            disabled={camProj === 'ortho'}
            title={camProj === 'ortho' ? 'Pohled shora (ortho) zorný úhel nemá — přepni na perspektivu' : undefined}
            onChange={e => { const d = Number(e.target.value); look.setFov(d); look.applyFov(d) }}
            className="flex-1 min-w-0 disabled:opacity-40"
          />
          <span className={`w-8 text-right tabular-nums ${camProj === 'ortho' ? 'text-gray-600' : 'text-gray-300'}`}>{look.fov}°</span>
        </label>
        {/* DOF */}
        <div className="flex flex-col gap-1.5 border-t border-gray-700 pt-2">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={look.dofOn} onChange={e => { look.setDofOn(e.target.checked); look.applyDof({ on: e.target.checked }) }} className="accent-sky-500" />
            <span className="text-gray-200">Rozostření okrajů</span>
          </label>
          {look.dofOn && <>
            <div className="flex gap-1">
              {([['circle', 'Kruh uprostřed'], ['dist', 'Podle vzdálenosti']] as const).map(([m, lbl]) => (
                <button
                  key={m}
                  onClick={() => { look.setDofMode(m); look.applyDof({ mode: m }) }}
                  className={`flex-1 px-2 py-1 rounded-lg text-xs ${look.dofMode === m ? 'bg-sky-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}
                >{lbl}</button>
              ))}
            </div>
            {look.dofMode === 'circle' ? <>
              <label className="flex items-center gap-1.5 text-xs">
                <span className="text-gray-400 w-16 shrink-0">Velikost</span>
                <input type="range" min={0.05} max={1.2} step={0.01} value={look.dofRadius} onChange={e => { const r = Number(e.target.value); look.setDofRadius(r); look.applyDof({ radius: r }) }} className="flex-1 min-w-0" title="Poloměr ostrého kruhu — 1,0 sahá k bližšímu okraji obrazovky" />
                <span className="w-12 text-right text-gray-300 tabular-nums">{Math.round(look.dofRadius * 100)} %</span>
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <span className="text-gray-400 w-16 shrink-0">Přechod</span>
                <input type="range" min={0.01} max={0.8} step={0.01} value={look.dofFeather} onChange={e => { const f = Number(e.target.value); look.setDofFeather(f); look.applyDof({ feather: f }) }} className="flex-1 min-w-0" title="Šířka přechodu z ostrého do rozmazaného — nízká hodnota dá ostrou hranu kruhu" />
                <span className="w-12 text-right text-gray-300 tabular-nums">{Math.round(look.dofFeather * 100)} %</span>
              </label>
            </> : <>
              <label className="flex items-center gap-1.5 text-xs">
                <span className="text-gray-400 w-16 shrink-0">Ostří v</span>
                <input type="range" min={10} max={3000} step={10} value={look.dofFocal} onChange={e => { const f = Number(e.target.value); look.setDofFocal(f); look.applyDof({ focal: f }) }} className="flex-1 min-w-0" />
                <span className="w-12 text-right text-gray-300 tabular-nums">{look.dofFocal} m</span>
              </label>
              <button onClick={look.dofFocusCenter} className="px-2 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-200">Zaostřit na střed pohledu</button>
            </>}
            <label className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-400 w-16 shrink-0">Rozmazání</span>
              <input type="range" min={1} max={7} step={0.5} value={look.dofBlur} onChange={e => { const b = Number(e.target.value); look.setDofBlur(b); look.applyDof({ blur: b }) }} className="flex-1 min-w-0" />
              <span className="w-12 text-right text-gray-300 tabular-nums">{look.dofBlur}</span>
            </label>
          </>}
        </div>
        {/* Bloom */}
        <label className="flex items-center gap-1.5 text-xs border-t border-gray-700 pt-2 cursor-pointer">
          <input type="checkbox" checked={look.bloomOn} onChange={e => { look.setBloomOn(e.target.checked); look.applyBloom(e.target.checked) }} className="accent-sky-500" />
          <span className="text-gray-200">Bloom (jemná záře)</span>
        </label>
        {/* Handheld — jemné chvění pohledu; ukládá se s pohledem, běží jen v prezentaci */}
        <div className="flex flex-col gap-1.5 border-t border-gray-700 pt-2">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer" title="Jemné rozechvění pohledu jako z ruky. Ukládá se s pohledem (tlačítko Uložit / ikona fotoaparátu), takže si ho dáš jen na záběry, kterým sluší. Pracuje jen opticky — kamera, přelety ani ovládání myší se tím nemění.">
            <input type="checkbox" checked={shakeOn} onChange={e => setShakeOn(e.target.checked)} className="accent-sky-500" />
            <span className="text-gray-200">Kamera z ruky (jemné chvění)</span>
            {shakeOn && !presentOn && <span className="ml-auto shrink-0 text-[10px] text-amber-500/80">jen v prezentaci</span>}
          </label>
          {shakeOn && (
            <label className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-400 w-16 shrink-0">Intenzita</span>
              <input type="range" min={0.05} max={1} step={0.05} value={shakeAmt} onChange={e => setShakeAmt(Number(e.target.value))} className="flex-1 min-w-0" title="Délka tahu — i na 100 % je to asi stupeň, tedy pomalé plutí, ne třas" />
              <span className="w-12 text-right text-gray-300 tabular-nums">{Math.round(shakeAmt * 100)} %</span>
            </label>
          )}
        </div>
        {/* Kroužení — kamera pomalu obíhá střed pohledu; ukládá se s pohledem, běží v prezentaci */}
        <div className="flex flex-col gap-1.5 border-t border-gray-700 pt-2">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer" title="Kamera velmi pomalu obíhá kolem místa, na které se pohled dívá, a drží ho uprostřed. Ukládá se s pohledem (tlačítko Uložit / ikona fotoaparátu). Střed se vezme po doletu na pohled.">
            <input type="checkbox" checked={spinOn} onChange={e => setSpinOn(e.target.checked)} className="accent-sky-500" />
            <span className="text-gray-200">Kroužení kolem místa</span>
            {spinOn && !presentOn && <span className="ml-auto shrink-0 text-[10px] text-amber-500/80">jen v prezentaci</span>}
          </label>
          {spinOn && (<>
            <label className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-400 w-16 shrink-0">Rychlost</span>
              <input
                type="range" min={0.1} max={3} step={0.1} value={Math.abs(spinSpeed)}
                onChange={e => setSpinSpeed(Math.sign(spinSpeed || 1) * Number(e.target.value))}
                className="flex-1 min-w-0"
                title="Jak rychle kamera obíhá. I na maximu je to pomalý drift, ne otáčka."
              />
              <span className="w-12 text-right text-gray-300 tabular-nums">
                {(() => { const s = Math.round(360 / Math.abs(spinSpeed || 1)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` })()}
              </span>
            </label>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-400 w-16 shrink-0">Směr</span>
              {([[-1, 'doleva'], [1, 'doprava']] as const).map(([dir, lbl]) => (
                <button
                  key={dir}
                  onClick={() => setSpinSpeed(dir * Math.abs(spinSpeed || 1))}
                  className={`flex-1 rounded-lg px-2 py-1 text-xs ${Math.sign(spinSpeed || 1) === dir ? 'bg-sky-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                >{lbl}</button>
              ))}
            </div>
            <div className="px-1 text-[10px] leading-snug text-gray-600">Čas je jedna celá otáčka.</div>
          </>)}
        </div>
    </>
  )
}
