/**
 * Mapa pro kouřový test v prohlížeči (`npm run smoke`, viz scripts/smoke.mjs) — bez přihlášení
 * a bez Supabase: scéna je podvržená a ukládání nedělá nic. Ručně se nespouští.
 *
 * Pro test si vystavuje dvě věci: `window.__errors` (výjimky, odmítnuté sliby i chyby Reactu)
 * a `window.__scene` (scéna Cesia, ať jde ověřit, že se mapa opravdu kreslí).
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Cesium from 'cesium'
import { AppToaster } from '../../src/appToaster'
import { DialogHost } from '../../src/dialog'
import '../../src/index.css'
import { MapView } from '../../src/MapView'
import type { ScenePersist } from '../../src/lib/scenePersist'

const errors: string[] = []
const note = (e: unknown) => errors.push((e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)).slice(0, 2000))
window.addEventListener('error', e => note(e.error ?? e.message))
window.addEventListener('unhandledrejection', e => note(e.reason))
Object.assign(window, { __errors: errors })

const render = Cesium.Scene.prototype.render
Cesium.Scene.prototype.render = function (this: Cesium.Scene, ...args: unknown[]) {
  Object.assign(window, { __scene: this })
  return (render as (...a: unknown[]) => void).apply(this, args)
}

// výchozí pohled: kolmo nad centrem Českých Budějovic; jde přepsat v adrese (?lon=&lat=&h=)
const q = new URLSearchParams(location.search)
const start = Cesium.Cartesian3.fromDegrees(Number(q.get('lon') ?? 14.4746), Number(q.get('lat') ?? 48.9745), Number(q.get('h') ?? 1500))
const scene: ScenePersist = {
  sceneId: 'smoke', sceneName: 'Kouřový test', ownerId: 'nikdo',
  initial: { camera: { dest: [start.x, start.y, start.z], h: 0, p: Cesium.Math.toRadians(-89.9), r: 0 } } as unknown as ScenePersist['initial'],
  assets: [],
  patchState: () => {},
  uploadAsset: async () => { throw new Error('V kouřovém testu se nenahrává') },
  patchAssetConfig: () => {},
  renameAsset: async () => {},
  deleteAsset: async () => {},
  // náhled scény při odchodu: test zkontroluje typ, rozměr a že není černý
  saveThumb: async img => {
    const bmp = await createImageBitmap(img)
    const c = document.createElement('canvas'); c.width = 32; c.height = 18
    const g = c.getContext('2d')!
    g.drawImage(bmp, 0, 0, 32, 18)
    const px = g.getImageData(0, 0, 32, 18).data
    let sum = 0
    for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3
    Object.assign(window, { __thumb: { size: img.size, type: img.type, w: bmp.width, h: bmp.height, mean: sum / (px.length / 4) } })
  },
  exit: () => {},
}

createRoot(document.getElementById('root')!, { onUncaughtError: note, onCaughtError: note })
  .render(<StrictMode><MapView scene={scene} /><AppToaster /><DialogHost /></StrictMode>)
