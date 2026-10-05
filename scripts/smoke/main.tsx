/**
 * Mapa pro kouřový test v prohlížeči (`npm run smoke`, viz scripts/smoke.mjs) — bez přihlášení
 * a bez Supabase: scéna je podvržená a ukládání nedělá nic. Ručně se nespouští.
 *
 * Pro test si vystavuje dvě věci: `window.__errors` (výjimky, odmítnuté sliby i chyby Reactu)
 * a `window.__scene` (scéna Cesia, ať jde ověřit, že se mapa opravdu kreslí).
 *
 * `?access=viewer|editor` otevře scénu jako cizí (sdílenou); jinak je moje a jde sdílet —
 * okno sdílení mluví s podvrženým REST API (fakeRest.ts), ne se Supabase.
 *
 * `?page=view#/view/<kód>` je veřejný prohlížeč přesně jako v appce (ViewPage): anonymní
 * přihlášení i otevření odkazu jdou proti podvrženému API.
 */
import './fakeRest' // první: klient Supabase si fetch bere hned při načtení
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Cesium from 'cesium'
import { AppToaster } from '../../src/appToaster'
import { DialogHost } from '../../src/dialog'
import { IonKeyHost, openIonKeyDialog } from '../../src/ionKeyDialog'
import { ShareHost, openShareDialog } from '../../src/shareDialog'
import '../../src/index.css'
import { MapView } from '../../src/MapView'
import type { ScenePersist } from '../../src/lib/scenePersist'
import { HashRouter, Route, Routes } from 'react-router-dom'
import type { User } from '@supabase/supabase-js'
import { AccountPage } from '../../src/pages/AccountPage'
import { ViewPage } from '../../src/pages/ViewPage'
import { useAuthStore } from '../../src/stores/authStore'

const errors: string[] = []
const note = (e: unknown) => errors.push((e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)).slice(0, 2000))
window.addEventListener('error', e => note(e.error ?? e.message))
window.addEventListener('unhandledrejection', e => note(e.reason))
Object.assign(window, { __errors: errors, __openIonKey: openIonKeyDialog, __ion: () => Cesium.Ion.defaultAccessToken }) // okno klíče ion bez načítání Google 3D (to by čerpalo kvótu)

const render = Cesium.Scene.prototype.render
Cesium.Scene.prototype.render = function (this: Cesium.Scene, ...args: unknown[]) {
  Object.assign(window, { __scene: this })
  return (render as (...a: unknown[]) => void).apply(this, args)
}

// výchozí pohled: kolmo nad centrem Českých Budějovic; jde přepsat v adrese (?lon=&lat=&h=)
const q = new URLSearchParams(location.search)
// `?localdxf=<velikost>`: scéna s výkresem uloženým „jen v jiném počítači" (lib/localFiles.ts) —
// test ho pak dohledá na disku a ověří, že se příště načte sám
const localDxf = q.get('localdxf')
const assets: ScenePersist['assets'] = localDxf ? [{
  id: 'smoke-local-1', scene_id: 'smoke', owner: 'nikdo', kind: 'drawing', name: 'Výkres jen v počítači',
  file_name: 'mimo-uloziste.dxf', file_path: 'local:smoke-local-1/file', sidecar_path: null, sidecar_name: null,
  size_bytes: Number(localDxf), config: {}, sort_order: 0, created_at: '', updated_at: '',
}] : []
const access = q.get('access') === 'viewer' ? 'viewer' : q.get('access') === 'editor' ? 'editor' : 'owner'
const start = Cesium.Cartesian3.fromDegrees(Number(q.get('lon') ?? 14.4746), Number(q.get('lat') ?? 48.9745), Number(q.get('h') ?? 1500))
const scene: ScenePersist = {
  sceneId: 'smoke', sceneName: 'Kouřový test', ownerId: 'nikdo',
  access, ownerName: access === 'owner' ? null : 'Jana',
  share: access === 'owner' ? () => openShareDialog({ sceneId: 'smoke', sceneName: 'Kouřový test' }) : undefined,
  initial: { camera: { dest: [start.x, start.y, start.z], h: 0, p: Cesium.Math.toRadians(-89.9), r: 0 } } as unknown as ScenePersist['initial'],
  assets,
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

// `?page=view`: veřejný prohlížeč — přihlášení se obnovuje jako v appce (App.tsx → init)
const viewPage = () => {
  useAuthStore.getState().init()
  return <HashRouter><Routes><Route path="/view/:token" element={<ViewPage />} /></Routes></HashRouter>
}

// `?page=account`: Nastavení účtu s podvrženým uživatelem — test projde formuláře bez Supabase
const page = q.get('page') === 'view' ? viewPage() : q.get('page') === 'account'
  ? (() => {
      useAuthStore.setState({
        user: { id: 'u-smoke', email: 'test@example.cz', user_metadata: {}, app_metadata: {}, aud: 'authenticated', created_at: '' } as unknown as User,
        profile: { id: 'u-smoke', email: 'test@example.cz', display_name: 'Test', created_at: '' },
        loading: false,
      })
      return <HashRouter><AccountPage /></HashRouter>
    })()
  : <MapView scene={scene} />

createRoot(document.getElementById('root')!, { onUncaughtError: note, onCaughtError: note })
  .render(<StrictMode>{page}<AppToaster /><ShareHost /><DialogHost /><IonKeyHost /></StrictMode>)
