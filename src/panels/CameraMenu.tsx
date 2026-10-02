/**
 * Panel „Kamera" v liště dole: uložené pohledy a vzhled kamery na jednom místě.
 *
 * Dřív to byly dvě sekce levého panelu (Pohledy, Vzhled kamery) a panel kvůli nim rostl. Jsou to
 * dvě záložky, ať nabídka nezabere půl obrazovky; poslední otevřená se pamatuje. Perspektiva /
 * shora zůstává jako samostatná skupina lišty — přepíná se často a jedním klikem.
 */
import { useState } from 'react'
import { Aperture, Clapperboard } from 'lucide-react'
import { CamViews } from '../camViews'
import { LookPanel } from './LookPanel'
import type { CamViewsTool } from '../useCamViews'
import type { CameraMotion } from '../useCameraMotion'
import type { LookTool } from '../useLookTool'

type Tab = 'views' | 'look'
const TAB_KEY = 'geo.kameraTab'

export function CameraMenu({ views, look, motion, presentOn }: {
  views: CamViewsTool
  look: LookTool
  motion: CameraMotion
  presentOn: boolean
}) {
  const [tab, setTabState] = useState<Tab>(() => {
    try { return localStorage.getItem(TAB_KEY) === 'look' ? 'look' : 'views' } catch { return 'views' }
  })
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t) } catch { /* */ } }
  const { camProj, orbitOn, setOrbitOn } = motion
  const tabCls = (on: boolean) => `flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
    on ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:text-gray-200'
  }`

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex gap-1 rounded-lg bg-gray-800/70 p-0.5">
        <button onClick={() => setTab('views')} className={tabCls(tab === 'views')}>
          <Clapperboard size={13} /> Pohledy{views.camViews.length > 0 && <span className="tabular-nums text-gray-500">{views.camViews.length}</span>}
        </button>
        <button onClick={() => setTab('look')} className={tabCls(tab === 'look')}>
          <Aperture size={13} /> Vzhled
        </button>
      </div>
      {tab === 'views' ? (
        <>
          <CamViews
            views={views.camViews}
            activeId={views.activeViewId}
            dirty={views.activeDirty}
            renamingId={views.renamingViewId}
            onRenameStart={views.setRenamingViewId}
            onRename={views.renameCamView}
            onGoto={views.gotoCamView}
            onOverwrite={views.updateCamView}
            onDuplicate={views.duplicateCamView}
            onDelete={views.delCamView}
            onMove={views.moveCamView}
            onSave={views.saveCamView}
            onStep={views.stepCamView}
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-xs" title="Kamera nepoletí napřímo, ale obloukem kolem toho, na co zrovna koukáš — objekt uprostřed zůstane uprostřed.">
            <input type="checkbox" checked={orbitOn} onChange={e => setOrbitOn(e.target.checked)} className="accent-sky-500" />
            <span className="text-gray-200">Přelet obloukem (orbit kolem středu)</span>
          </label>
        </>
      ) : (
        <LookPanel
          look={look} camProj={camProj} presentOn={presentOn}
          shakeOn={motion.shakeOn} setShakeOn={motion.setShakeOn} shakeAmt={motion.shakeAmt} setShakeAmt={motion.setShakeAmt}
          spinOn={motion.spinOn} setSpinOn={motion.setSpinOn} spinSpeed={motion.spinSpeed} setSpinSpeed={motion.setSpinSpeed}
        />
      )}
    </div>
  )
}
