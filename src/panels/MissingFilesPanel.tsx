/**
 * Sekce „Chybějící soubory": soubory scény uložené jen v jiném počítači (byly na úložiště moc
 * velké, viz lib/localFiles.ts). Scéna o nich ví, jen tu nemá jejich bajty — tady se dají
 * dohledat na disku. Vybraný soubor se uloží i do tohohle počítače a příště se načte sám.
 */
import { useRef } from 'react'
import { Box, FileSearch, Image, PenLine, Trash2 } from 'lucide-react'
import type { AssetRow } from '../lib/types'

const fmtSize = (b: number) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} kB` : `${(b / 1048576).toFixed(1)} MB`)
const extOf = (n: string) => { const i = n.lastIndexOf('.'); return i >= 0 ? n.slice(i).toLowerCase() : '' }

export function MissingFilesPanel({ files, onRelink, onRemove }: {
  files: AssetRow[]
  /** vybrané soubory k jednomu chybějícímu (u rastru i world file) */
  onRelink: (a: AssetRow, picked: File[]) => void
  /** soubor je nenávratně pryč — odebrat ho ze scény */
  onRemove: (a: AssetRow) => void
}) {
  return (
    <>
      <div className="px-1 text-[10px] leading-snug text-gray-500">
        Tyhle soubory byly na úložiště moc velké, takže zůstaly v počítači, kde se nahrály. Vyber je na disku —
        uloží se i sem a příště se načtou samy.
      </div>
      {files.map(a => <Row key={a.id} a={a} onRelink={onRelink} onRemove={onRemove} />)}
    </>
  )
}

function Row({ a, onRelink, onRemove }: { a: AssetRow; onRelink: (a: AssetRow, picked: File[]) => void; onRemove: (a: AssetRow) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const icon = a.kind === 'model' ? <Box size={14} /> : a.kind === 'drawing' ? <PenLine size={14} /> : <Image size={14} />
  // rastr s world filem: vybrat oba najednou
  const accept = [extOf(a.file_name), a.sidecar_name ? extOf(a.sidecar_name) : ''].filter(Boolean).join(',')
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-gray-800/60 p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-amber-400">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-gray-100" title={a.name}>{a.name}</span>
        <button onClick={() => onRemove(a)} title="Soubor je pryč — odebrat ho ze scény" className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-700 hover:text-red-300">
          <Trash2 size={12} />
        </button>
      </div>
      <div className="truncate px-0.5 text-[10px] text-gray-500" title={a.file_name}>
        {a.file_name}{a.sidecar_name ? ` + ${a.sidecar_name}` : ''}{a.size_bytes ? ` · ${fmtSize(a.size_bytes)}` : ''}
      </div>
      <button
        onClick={() => input.current?.click()}
        className="flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-2 py-1 text-xs text-white hover:bg-amber-500"
      >
        <FileSearch size={13} /> Najít soubor…
      </button>
      <input
        ref={input}
        type="file"
        multiple={!!a.sidecar_name}
        accept={accept || undefined}
        data-relink-input={a.id}
        className="hidden"
        onChange={e => {
          const picked = [...(e.target.files ?? [])]
          e.target.value = '' // tentýž soubor půjde vybrat znovu
          if (picked.length) onRelink(a, picked)
        }}
      />
    </div>
  )
}
