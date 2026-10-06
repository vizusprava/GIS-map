/** Dekódování GeoTIFFu mimo hlavní vlákno (worker v tiffWorker.ts, mechanika ve workerClient.ts). */
import { decodeTiffPixels, type TiffPixels } from './tiffDecode'
import { workerClient } from './workerClient'

const run = workerClient<{ file: File }, TiffPixels>({
  create: () => new Worker(new URL('./tiffWorker.ts', import.meta.url), { type: 'module', name: 'rastry' }),
  onMain: ({ file }) => decodeTiffPixels(file),
  crashMessage: 'Dekódování snímku spadlo — nejspíš na něj nestačila paměť prohlížeče.',
})

export const decodeTiffFile = (file: File) => run({ file })
