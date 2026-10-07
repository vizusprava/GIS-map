/**
 * Příprava 3D modelu mimo hlavní vlákno (worker v modelWorker.ts, mechanika ve workerClient.ts).
 * Co ve workeru nejde, doběhne na hlavním vlákně — model se načte vždycky, jen pomaleji.
 */
import { prepareModel, type PreparedModel, type PrepareOpts } from './model3d'
import { workerClient } from './workerClient'

export type ModelRequest = { file: File; opts: PrepareOpts }

const run = workerClient<ModelRequest, PreparedModel>({
  create: () => new Worker(new URL('./modelWorker.ts', import.meta.url), { type: 'module', name: 'modely' }),
  onMain: async ({ file, opts }) => prepareModel(file.name, await file.arrayBuffer(), { ...opts, strict: false }),
  crashMessage: 'Zpracování modelu spadlo — nejspíš na něj nestačila paměť prohlížeče.',
  retryOnMain: true,
})

/**
 * Model připravený pro Cesium: zjednodušené materiály vždycky, k tomu převedený OBJ,
 * georeferencovaný GLB z S-JTSK souřadnic (`georef`) nebo změřený nejnižší bod (`measure`) —
 * viz `prepareModel`.
 */
export function prepareModelFile(file: File, opts: { georef: boolean; measure: boolean }): Promise<PreparedModel> {
  return run({ file, opts })
}
