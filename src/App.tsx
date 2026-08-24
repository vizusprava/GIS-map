/**
 * Routy a stráž přihlášení.
 *
 * HashRouter schválně: appka běží jako statické soubory (GitHub Pages, Netlify, sdílený
 * hosting) a s hash cestami nepotřebuje na serveru žádné přepisování URL. Odkazy z e-mailů
 * (potvrzení účtu, změna hesla) se s tím nebijí, protože klient jede v PKCE flow, kde token
 * chodí v query (`?code=`), ne ve fragmentu.
 */
import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from './stores/authStore'
import { LoginPage } from './pages/LoginPage'
import { NewPasswordPage } from './pages/NewPasswordPage'
import { ScenesPage } from './pages/ScenesPage'
import { ScenePage } from './pages/ScenePage'

function Gate({ children }: { children: React.ReactNode }) {
  const { user, loading, recovery } = useAuthStore()

  // Dokud se neobnoví session, nic nepřesměrovávat — jinak by po refreshi bliklo přihlášení.
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-gray-500" />
      </div>
    )
  }
  if (!user) return <LoginPage />
  // Přišel z odkazu „zapomenuté heslo" → nejdřív si ho musí nastavit.
  if (recovery) return <NewPasswordPage />
  return <>{children}</>
}

export default function App() {
  const init = useAuthStore(s => s.init)
  useEffect(() => init(), [init])

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Gate><ScenesPage /></Gate>} />
        <Route path="/scene/:id" element={<Gate><ScenePage /></Gate>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
