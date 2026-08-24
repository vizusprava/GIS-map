/**
 * Nastavení nového hesla po kliknutí na odkaz z e-mailu.
 *
 * Supabase v tu chvíli přihlásí uživatele „na jedno použití" a pošle událost
 * PASSWORD_RECOVERY. Dokud si heslo nezmění (nebo se neodhlásí), appku mu neukazujeme —
 * jinak by mu odkaz jen tiše otevřel účet a on by si heslo nikdy nezměnil.
 */
import { useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '../stores/authStore'

export function NewPasswordPage() {
  const { setPassword, signOut } = useAuthStore()
  const [pwd, setPwd] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (pwd !== again) { toast.error('Hesla se neshodují.'); return }
    setBusy(true)
    try {
      await setPassword(pwd)
      toast.success('Heslo změněno.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Změna hesla selhala')
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-100 ' +
    'placeholder:text-gray-500 outline-none focus:border-emerald-500/70 focus:ring-1 focus:ring-emerald-500/40'

  return (
    <div className="h-full flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3">
        <div className="flex items-center gap-2 mb-4 text-gray-100">
          <KeyRound size={18} className="text-emerald-400" />
          <h1 className="text-base font-bold">Nové heslo</h1>
        </div>
        <input
          className={inputClass} type="password" required minLength={6} autoComplete="new-password"
          placeholder="Nové heslo" value={pwd} onChange={e => setPwd(e.target.value)}
        />
        <input
          className={inputClass} type="password" required minLength={6} autoComplete="new-password"
          placeholder="Nové heslo znovu" value={again} onChange={e => setAgain(e.target.value)}
        />
        <button
          type="submit" disabled={busy}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-sm font-medium"
        >
          {busy && <Loader2 size={16} className="animate-spin" />} Uložit heslo
        </button>
        <button
          type="button" onClick={() => void signOut()}
          className="w-full text-xs text-gray-500 hover:text-gray-300 pt-1"
        >
          Zrušit a odhlásit se
        </button>
      </form>
    </div>
  )
}
