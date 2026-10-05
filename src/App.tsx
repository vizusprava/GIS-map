/**
 * Routy a stráž přihlášení.
 *
 * HashRouter schválně: appka běží jako statické soubory (GitHub Pages, Netlify, sdílený
 * hosting) a s hash cestami nepotřebuje na serveru žádné přepisování URL. Odkazy z e-mailů
 * (potvrzení účtu, změna hesla) se s tím nebijí, protože klient jede v PKCE flow, kde token
 * chodí v query (`?code=`), ne ve fragmentu.
 */
import { lazy, Suspense, useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from './stores/authStore'
import { LoginPage } from './pages/LoginPage'
import { NewPasswordPage } from './pages/NewPasswordPage'
import { ScenesPage } from './pages/ScenesPage'
import { AccountPage } from './pages/AccountPage'
import { loadChunk } from './lib/lazyChunk'
import { Backdrop } from './backdrop/Backdrop'

// Scéna táhne Cesium i three.js — přes 8 MB skriptu. Přihlášení a přehled scén ho nepotřebují,
// tak se stáhne až při otevření scény.
const ScenePage = lazy(() => loadChunk(() => import('./pages/ScenePage')).then(m => ({ default: m.ScenePage })))
const ViewPage = lazy(() => loadChunk(() => import('./pages/ViewPage')).then(m => ({ default: m.ViewPage })))

function Spinner() {
  return (
    <div className="h-full flex items-center justify-center">
      <Loader2 size={20} className="animate-spin text-gray-500" />
    </div>
  )
}

function Gate({ children }: { children: React.ReactNode }) {
  const { user, loading, recovery } = useAuthStore()

  // Dokud se neobnoví session, nic nepřesměrovávat — jinak by po refreshi bliklo přihlášení.
  if (loading) return <Spinner />
  // Anonymní přihlášení je jen pro veřejný prohlížeč scény (odkaz) — do appky jako takové ne.
  if (!user || user.is_anonymous) return <LoginPage />
  // Přišel z odkazu „zapomenuté heslo" → nejdřív si ho musí nastavit.
  if (recovery) return <NewPasswordPage />
  return <>{children}</>
}

/**
 * Pozadí s krajinou za přihlášením (rozkládající se vrstvy) a za přehledem scén (přiblížený
 * terén). Žije nad routami, ať se po přihlášení přehraje přechod jednoho v druhé. Ve scéně
 * s mapou ani v prohlížeči odkazu se nekreslí vůbec — grafika patří Cesiu.
 */
function BackdropHost() {
  const { pathname } = useLocation()
  const user = useAuthStore(s => s.user)
  const loading = useAuthStore(s => s.loading)
  const recovery = useAuthStore(s => s.recovery)
  // dokud se neobnoví přihlášení, nevíme, který stav ukázat — přechod by se přehrál zbytečně
  if (loading || pathname.startsWith('/scene/') || pathname.startsWith('/view/')) return null
  return <Backdrop mode={!user || user.is_anonymous || recovery ? 'login' : 'overview'} />
}

export default function App() {
  const init = useAuthStore(s => s.init)
  useEffect(() => init(), [init])

  return (
    <HashRouter>
      <BackdropHost />
      <Routes>
        <Route path="/" element={<Gate><ScenesPage /></Gate>} />
        <Route path="/account" element={<Gate><AccountPage /></Gate>} />
        <Route path="/scene/:id" element={<Gate><Suspense fallback={<Spinner />}><ScenePage /></Suspense></Gate>} />
        {/* odkaz jen pro prohlížení — bez přihlášení (ViewPage si případně přihlásí anonyma) */}
        <Route path="/view/:token" element={<Suspense fallback={<Spinner />}><ViewPage /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
