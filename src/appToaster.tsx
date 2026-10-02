/**
 * Oznámení (sonner) v tmavém vzhledu appky — dřív svítila bílá přes tmavou mapu. Vpravo dole,
 * ale nad lištou nástrojů a kompasem, nejvýš tři naráz, s křížkem; hláška zmizí za 3,5 s, pokud
 * si volající neřekne o jinou dobu (`toast.info(…, { duration })`).
 */
import { Toaster } from 'sonner'

export function AppToaster() {
  return (
    <Toaster
      position="bottom-right"
      offset={{ bottom: 88 }}
      theme="dark"
      richColors
      closeButton
      visibleToasts={3}
      duration={3500}
      toastOptions={{ className: 'text-xs' }}
    />
  )
}
