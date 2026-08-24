import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import './index.css'
import App from './App.tsx'

/**
 * Přechodný rozjezd hodin mezi auth serverem a PostgRESTem.
 *
 * GoTrue orazítkuje čerstvý token `iat` podle svých hodin, PostgREST ho pak porovná proti
 * svým a žádnou toleranci nemá. Mezi přihlášením a prvním dotazem na data přitom uběhne
 * jen pár desítek milisekund, takže když auth server předběhne o zlomek vteřiny, přijde na
 * úplně platný token 401 „JWT issued at future". Za chvilku projde ten samý token beze
 * změny — proto se vyplatí počkat a zkusit to znovu, ne chybu ukázat uživateli.
 */
const isJwtClockSkew = (e: unknown) =>
  /JWT (issued at future|expired)/i.test((e instanceof Error ? e.message : '') || '')

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Jen rozjeté hodiny. Cokoliv jiného ať spadne hned — opakování by skutečnou
      // chybu jen schovalo a natáhlo dobu, než se o ní člověk dozví.
      retry: (count, error) => count < 3 && isJwtClockSkew(error),
      retryDelay: (count) => Math.min(300 * 2 ** count, 2000),
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster position="bottom-right" richColors />
    </QueryClientProvider>
  </StrictMode>,
)
