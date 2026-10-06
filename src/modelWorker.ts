/**
 * Worker na přípravu 3D modelu (model3d.ts → `prepareModel`): parsování three.js, georeference
 * každého vrcholu z S-JTSK, obrys půdorysu a zpětný export do GLB. U modelu z 3ds Maxu
 * s miliony vrcholů to jsou klidně desítky vteřin — na hlavním vlákně by po tu dobu stála
 * celá mapa i s myší.
 *
 * `strict`: soubor, který tady three nepřečte, je chyba — klient to pak zkusí ještě na
 * hlavním vlákně (starší Safari neumí ve workeru dekódovat textury), viz modelClient.ts.
 */
import { prepareModel, type PreparedModel } from './model3d'
import { serveWorker } from './workerClient'
import type { ModelRequest } from './modelClient'

serveWorker<ModelRequest, PreparedModel>(
  async ({ file, georef }) => prepareModel(file.name, await file.arrayBuffer(), georef, { strict: true }),
  res => (res.glb ? [res.glb] : []),
)
