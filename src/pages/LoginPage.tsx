/**
 * Přihlášení, registrace a zapomenuté heslo — jedna stránka, tři režimy.
 *
 * Registrace je otevřená: kdokoliv si udělá účet e-mailem a heslem. Když má projekt
 * v Supabase zapnuté potvrzování e-mailu, po registraci session nevznikne a uživatel
 * musí kliknout na odkaz v poště — proto to `signUp` hlásí zvlášť a my o tom řekneme.
 */
import { useState } from 'react'
import { Globe2, Loader2, Mail, Lock, User as UserIcon, ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '../stores/authStore'
import { supabaseConfigured } from '../lib/supabase'

type Mode = 'login' | 'signup' | 'reset'

const inputClass =
  'w-full bg-gray-900 border border-gray-700 rounded-xl pl-10 pr-3 py-2.5 text-sm text-gray-100 ' +
  'placeholder:text-gray-500 outline-none focus:border-emerald-500/70 focus:ring-1 focus:ring-emerald-500/40'

export function LoginPage() {
  const { signIn, signUp, resetPassword } = useAuthStore()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      if (mode === 'login') {
        await signIn(email, password)
        // dál už appku přesměruje AuthGuard, jak se objeví session
      } else if (mode === 'signup') {
        const needsConfirm = await signUp(email, password, name || email.split('@')[0])
        if (needsConfirm) {
          toast.success('Účet vytvořen — potvrď ho odkazem, který ti přišel na e-mail.')
          setMode('login')
        } else {
          toast.success('Účet vytvořen, jsi přihlášený.')
        }
      } else {
        await resetPassword(email)
        toast.success('Poslali jsme ti odkaz na změnu hesla.')
        setMode('login')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Něco se nepovedlo')
    } finally {
      setBusy(false)
    }
  }

  if (!supabaseConfigured) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-bold text-gray-100 mb-2">Chybí připojení k backendu</h1>
          <p className="text-sm text-gray-400">
            Doplň <code className="text-emerald-400">VITE_SUPABASE_URL</code> a{' '}
            <code className="text-emerald-400">VITE_SUPABASE_ANON</code> do <code>.env.local</code>{' '}
            (vzor je v <code>.env.example</code>) a spusť dev server znovu.
          </p>
        </div>
      </div>
    )
  }

  const title = mode === 'login' ? 'Přihlášení' : mode === 'signup' ? 'Nový účet' : 'Zapomenuté heslo'
  const action = mode === 'login' ? 'Přihlásit se' : mode === 'signup' ? 'Vytvořit účet' : 'Poslat odkaz'

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-xl bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center">
            <Globe2 size={22} className="text-emerald-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-100">GIS Map</h1>
            <p className="text-xs text-gray-500">3D modely a výkresy v reálném světě</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <h2 className="text-sm font-medium text-gray-300">{title}</h2>

          {mode === 'signup' && (
            <div className="relative">
              <UserIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                className={inputClass} placeholder="Jméno (nepovinné)" autoComplete="name"
                value={name} onChange={e => setName(e.target.value)}
              />
            </div>
          )}

          <div className="relative">
            <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              className={inputClass} type="email" required placeholder="E-mail" autoComplete="email"
              value={email} onChange={e => setEmail(e.target.value)}
            />
          </div>

          {mode !== 'reset' && (
            <div className="relative">
              <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                className={inputClass} type="password" required minLength={6} placeholder="Heslo"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password} onChange={e => setPassword(e.target.value)}
              />
            </div>
          )}

          <button
            type="submit" disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-sm font-medium transition-colors"
          >
            {busy && <Loader2 size={16} className="animate-spin" />} {action}
          </button>
        </form>

        <div className="mt-5 flex items-center justify-between text-xs">
          {mode === 'login' ? (
            <>
              <button onClick={() => setMode('signup')} className="text-emerald-400 hover:text-emerald-300">
                Vytvořit účet
              </button>
              <button onClick={() => setMode('reset')} className="text-gray-500 hover:text-gray-300">
                Zapomenuté heslo
              </button>
            </>
          ) : (
            <button onClick={() => setMode('login')} className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200">
              <ArrowLeft size={14} /> Zpět na přihlášení
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
