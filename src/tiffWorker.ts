/** Worker na dekódování GeoTIFFu (tiffDecode.ts); pixely se předají bez kopírování. */
import { decodeTiffPixels, type TiffPixels } from './tiffDecode'
import { serveWorker } from './workerClient'

serveWorker<{ file: File }, TiffPixels>(({ file }) => decodeTiffPixels(file), res => [res.rgba.buffer as ArrayBuffer])
