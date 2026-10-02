/**
 * Pravoúhlý pohled do řezu — to, co řez sám neumí.
 *
 * Řez spočítá jen průsečík s jednou rovinou. Výkres ale kromě řezné plochy potřebuje i
 * VIDĚT dozadu: nosníky, příčníky, zábradlí za rovinou, se správným zakrytím. Tady se to
 * bere z druhé strany — model se vykreslí pravoúhlou kamerou postavenou kolmo na rovinu
 * výkresu a zakrytí vyřeší hloubkový buffer. Přesně a zadarmo.
 *
 * Kamera je ZÁMĚRNĚ postavená ze stejných os jako řez (`planeBasis`) a se stejným počátkem,
 * takže obrázek lícuje s vektorovým obrysem na pixel — dá se položit pod něj a měřit přes obojí.
 *
 * Pravoúhlé promítání navíc drží lineární vztah pixel ↔ metr, takže z obrázku jde odečítat
 * skutečné rozměry; `pxPerM` je ten převod.
 */
import * as THREE from 'three'
import { planeBasis, forEachInstance } from './sectionCut'
import { meshEdges, isSilhouette, viewDirLocal, mergeSegments } from './meshEdges'

export interface SectionViewRect {
  minU: number
  maxU: number
  minV: number
  maxV: number
}

export interface SectionView {
  /** PNG jako data URL, průhledné pozadí */
  url: string
  widthPx: number
  heightPx: number
  /** výřez ve světových souřadnicích výkresu — podle něj se obrázek položí pod obrys */
  rect: SectionViewRect
  /** pixelů na metr; u pravoúhlé kamery je to konstanta pro celý obrázek */
  pxPerM: number
  ms: number
}

export interface SectionViewOptions {
  /** osa „vzhůru" pro orientaci výkresu; výchozí +Y, v mapě +Z */
  up?: THREE.Vector3
  /** okno výkresu napevno (přeostření na výsek); má přednost před `clip` */
  rect?: SectionViewRect
  /**
   * Stejné omezení jako u řezu (délka/výška). Bez něj se vezme celá obálka modelu.
   *
   * Záměrně to NENÍ obálka spočítaného obrysu: ta je jen tak velká, kam sáhla řezná rovina,
   * takže by pohled useknula v místě, kde obrys končí — a to je přesně ten „ořez ve výšce".
   */
  clip?: { center: THREE.Vector3; halfU?: number; halfV?: number }
  /** rozsah podél normály (výřez). Bez něj se kreslí vše na kladné straně roviny. */
  slab?: { from: number; to: number }
  /** delší strana obrázku v pixelech */
  size?: number
  /** bílý papír místo tmavého podkladu */
  paper?: boolean
  /** úhel, od kterého se hrana považuje za zlomovou (°) */
  edgeAngle?: number
  /**
   * Rozdělit promítnuté hrany na viditelné a zakryté podle hloubkové mapy.
   * Stojí jeden render navíc a přečtení bufferu, takže se zapíná jen pro finální výpočet.
   */
  occlusion?: boolean
  /** delší strana hloubkové mapy v pixelech; hrubší = rychlejší, ale méně přesné zakrytí */
  depthSize?: number
}

/**
 * Jeden sdílený renderer na celou aplikaci.
 *
 * Prohlížeč povoluje jen omezený počet WebGL kontextů a jeden už drží mapa — zakládat další
 * při každém výkresu by po pár řezech vedlo ke ztrátě kontextu a černé mapě.
 */
let renderer: THREE.WebGLRenderer | null = null
function getRenderer(): THREE.WebGLRenderer | null {
  if (renderer) return renderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1)
    renderer.localClippingEnabled = true
    return renderer
  } catch (e) {
    console.error('Pohled do řezu: nepodařilo se založit WebGL renderer', e)
    return null
  }
}

type Prepared = {
  scene: THREE.Scene
  fillMat: THREE.MeshLambertMaterial
  /** světlo se před každým snímkem postaví ke kameře, ať tón nezávisí na natočení řezu */
  light: THREE.DirectionalLight
}

/**
 * Připravená scéna se drží u modelu.
 *
 * Skládá se jen z PLOCH. Čáry si obstará vektorová vrstva (`projectSlabEdges`), která umí
 * i siluety a zakrytí — rastr je tady od tónu a hloubky, ne od linek. Dřív kreslil obojí
 * a rozcházely se: instancované hrany měl strop 400 kusů a `LineBasicMaterial` ve WebGL
 * stejně ignoruje tloušťku, takže čáry měly vždy 1 pixel a „zostřením" se ztenčovaly.
 *
 * `WeakMap`, aby se scéna uvolnila spolu s modelem a nedržela paměť po smazaném modelu.
 */
const sceneCache = new WeakMap<THREE.Object3D, Prepared>()

function prepareScene(root: THREE.Object3D, fill: number): Prepared {
  const hit = sceneCache.get(root)
  if (hit) {
    // barvy se mění přepnutím papíru — na to stačí přebarvit materiál, ne stavět znovu
    hit.fillMat.color.setHex(fill)
    return hit
  }

  const scene = new THREE.Scene()
  const fillMat = new THREE.MeshLambertMaterial({ color: fill, side: THREE.DoubleSide })
  // převažuje rozptýlené světlo, přisvícení od kamery jen dává tvar
  scene.add(new THREE.AmbientLight(0xffffff, 1.9))
  const light = new THREE.DirectionalLight(0xffffff, 1.1)
  scene.add(light)

  root.updateWorldMatrix(true, true)
  root.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return

    /**
     * `InstancedMesh` je jedna geometrie a k ní pole matic. Kdyby se vzala jen
     * `matrixWorld`, slily by se všechny instance do jedné — sloupky zábradlí nebo
     * svodidla by z pohledu zmizely úplně stejně, jako se to dřív dělo u řezu.
     */
    const inst = mesh as THREE.InstancedMesh
    if (inst.isInstancedMesh) {
      const solid = new THREE.InstancedMesh(mesh.geometry, fillMat, inst.count)
      solid.instanceMatrix.copy(inst.instanceMatrix)
      solid.instanceMatrix.needsUpdate = true
      solid.matrixAutoUpdate = false
      solid.matrix.copy(mesh.matrixWorld)
      scene.add(solid)
      return
    }

    const solid = new THREE.Mesh(mesh.geometry, fillMat)
    solid.matrixAutoUpdate = false
    solid.matrix.copy(mesh.matrixWorld)
    scene.add(solid)
  })

  const prepared: Prepared = { scene, fillMat, light }
  sceneCache.set(root, prepared)
  return prepared
}

/** Obálka modelu promítnutá do os výkresu, oříznutá na stejné okno jako řez. */
function computeRect(
  box: THREE.Box3,
  origin: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  opts: SectionViewOptions,
): SectionViewRect {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
  const c = new THREE.Vector3()
  for (let i = 0; i < 8; i++) {
    c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(origin)
    const cu = c.dot(u)
    const cv = c.dot(v)
    if (cu < minU) minU = cu; if (cu > maxU) maxU = cu
    if (cv < minV) minV = cv; if (cv > maxV) maxV = cv
  }
  if (opts.clip) {
    const rel = opts.clip.center.clone().sub(origin)
    const cu = rel.dot(u)
    const cv = rel.dot(v)
    if (opts.clip.halfU !== undefined) {
      minU = Math.max(minU, cu - opts.clip.halfU)
      maxU = Math.min(maxU, cu + opts.clip.halfU)
    }
    if (opts.clip.halfV !== undefined) {
      minV = Math.max(minV, cv - opts.clip.halfV)
      maxV = Math.min(maxV, cv + opts.clip.halfV)
    }
  }
  return { minU, maxU, minV, maxV }
}

/** Kamera pohledu — stejná pro obrázek i pro hloubkovou mapu, jinak by k sobě neseděly. */
function viewCamera(rect: SectionViewRect, origin: THREE.Vector3, v: THREE.Vector3, n: THREE.Vector3, diag: number) {
  const dist = diag * 2 + 10
  const near = 0.01
  const far = dist * 2 + diag
  const cam = new THREE.OrthographicCamera(rect.minU, rect.maxU, rect.maxV, rect.minV, near, far)
  cam.up.copy(v)
  cam.position.copy(origin).addScaledVector(n, dist)
  cam.lookAt(origin)
  cam.updateProjectionMatrix()
  return { cam, dist, near, far }
}

/**
 * Ořez výřezu: three zahodí bod na záporné straně kterékoliv roviny, takže dvě roviny
 * normálami proti sobě nechají přesně pás mezi nimi.
 */
function slabPlanes(origin: THREE.Vector3, n: THREE.Vector3, from: number, to: number) {
  return [
    new THREE.Plane().setFromNormalAndCoplanarPoint(n, origin.clone().addScaledVector(n, from)),
    new THREE.Plane().setFromNormalAndCoplanarPoint(n.clone().negate(), origin.clone().addScaledVector(n, to)),
  ]
}

/**
 * Terče a materiál pro hloubkovou mapu se drží a recyklují.
 *
 * Terč 2048² a pole na jeho přečtení je 16 MB; zakládat a zahazovat je při každém přepočtu
 * (a to třikrát, když je zapnutý kolmý řez i půdorys) znamená stálé alokace a práci pro
 * uklízeč paměti. Velikostí je v praxi pár, tak se drží podle rozměru.
 */
const depthPool = new Map<string, { target: THREE.WebGLRenderTarget; data: Uint8Array }>()
let depthMatShared: THREE.MeshDepthMaterial | null = null

function depthSlot(w: number, h: number) {
  const key = w + 'x' + h
  let slot = depthPool.get(key)
  if (!slot) {
    // víc než pár velikostí nikdy nepotkáme; kdyby ano, ať to nedrží paměť donekonečna
    if (depthPool.size >= 6) {
      const [oldKey, old] = depthPool.entries().next().value as [string, { target: THREE.WebGLRenderTarget }]
      old.target.dispose()
      depthPool.delete(oldKey)
    }
    slot = { target: new THREE.WebGLRenderTarget(w, h), data: new Uint8Array(w * h * 4) }
    depthPool.set(key, slot)
  }
  return slot
}

type DepthMap = {
  data: Uint8Array
  w: number
  h: number
  rect: SectionViewRect
  /** vzdálenost kamery od počátku podél normály */
  dist: number
  near: number
  far: number
}

/**
 * Hloubka zabalená do RGBA (`MeshDepthMaterial` + `RGBADepthPacking`) je 255/256 × podíl
 * jednotlivých bajtů — přesně opak toho, co dělá `unpackRGBAToDepth` v shaderu.
 */
function unpackDepth(d: Uint8Array, o: number): number {
  return (255 / 256) * (d[o] / 255 / 16777216 + d[o + 1] / 255 / 65536 + d[o + 2] / 255 / 256 + d[o + 3] / 255)
}
/** prázdné pozadí se do mapy zapíše jako „nekonečně daleko" */
const DEPTH_EMPTY = 0.9955

/**
 * Hloubková mapa výřezu: co je z pohledu vidět jako první.
 *
 * Kreslí se jen plné tvary (hrany se schovají — ležely by přesně na plochách a mapu by jen
 * zašuměly) pravoúhlou kamerou pohledu. Výsledek se přečte zpátky do paměti, takže se pak
 * dá pro každou promítnutou hranu zjistit, jestli je před přední plochou, nebo za ní.
 */
function renderDepthMap(
  root: THREE.Object3D,
  opts: SectionViewOptions,
  frame: { u: THREE.Vector3; v: THREE.Vector3; n: THREE.Vector3; box: THREE.Box3; diag: number; origin: THREE.Vector3 },
): DepthMap | null {
  const gl = getRenderer()
  if (!gl) return null
  const { v, n, box, diag, origin } = frame
  const rect = opts.rect ?? computeRect(box, origin, frame.u, v, opts)
  const rw = rect.maxU - rect.minU
  const rh = rect.maxV - rect.minV
  if (!(rw > 0) || !(rh > 0)) return null

  const cap = gl.capabilities?.maxTextureSize ?? 4096
  const size = Math.max(256, Math.min(cap, opts.depthSize ?? 2048))
  const w = Math.max(1, Math.round((size * rw) / Math.max(rw, rh)))
  const h = Math.max(1, Math.round((size * rh) / Math.max(rw, rh)))

  const prepared = prepareScene(root, 0xffffff)
  const { cam, dist, near, far } = viewCamera(rect, origin, v, n, diag)
  const from = opts.slab ? Math.min(opts.slab.from, opts.slab.to) : -diag * 2
  const to = opts.slab ? Math.max(opts.slab.from, opts.slab.to) : diag * 2

  const { target, data } = depthSlot(w, h)
  if (!depthMatShared) {
    depthMatShared = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide })
  }
  const depthMat = depthMatShared
  const prevClip = gl.clippingPlanes
  const prevTarget = gl.getRenderTarget()
  try {
    prepared.scene.overrideMaterial = depthMat
    gl.clippingPlanes = slabPlanes(origin, n, from, to)
    gl.setRenderTarget(target)
    // pozadí = zabalená 1.0, tedy „tady nic nestojí"
    gl.setClearColor(0x000000, 1)
    gl.clear()
    gl.render(prepared.scene, cam)
    gl.readRenderTargetPixels(target, 0, 0, w, h, data)
    return { data, w, h, rect, dist, near, far }
  } catch (e) {
    console.error('Hloubkovou mapu pohledu se nepodařilo spočítat:', e)
    return null
  } finally {
    prepared.scene.overrideMaterial = null
    gl.setRenderTarget(prevTarget)
    gl.clippingPlanes = prevClip
    gl.setClearAlpha(0)
    // terč ani materiál se nezahazují — drží se v `depthPool` na příště
  }
}

/**
 * Je bod v hloubce `own` schovaný za tím, co je v hloubkové mapě (`front`)?
 *
 * Rozhoduje JEDINÝ vzorek, schválně. Dřív se bral nejvzdálenější z křížového okolí, aby
 * hrana ležící na siluetě nepoblikávala — jenže tím se u všeho, co leží za nějakým tělesem,
 * podél jeho obrysu rozsvítil proužek: zakrytá hrana měla viditelné konce a ve výkrese
 * z toho byly kraťoučké čárky rozeseté kolem hran. Zrnitost mapy řeší až vyhlazení úseků
 * v `edgeRuns`, které osamělé vzorky zahodí, aniž by prosvěcovalo skrz.
 *
 * `bias` je tolerance: hrana leží PŘESNĚ na ploše, ze které pochází, takže bez ní by se
 * prohlásila za zakrytou sama sebou.
 */
export function isOccluded(own: number, front: number, bias: number): boolean {
  if (front >= DEPTH_EMPTY) return false          // v tom pixelu nic nestojí
  return own > front + bias
}

/**
 * Ořeže úsečku na kvádr daný mezemi ve všech třech osách výkresu (u, v a hloubka).
 *
 * Vrací rozsah parametru `[t0, t1]` uvnitř kvádru, nebo `null`, když úsečka kvádr míjí.
 * Bez tohohle by hrana, která do výřezu jen zasahuje, zůstala CELÁ — a ve výkrese by pak
 * trčela kus za hranu výřezu do prázdna, zatímco rastr pod ní je uříznutý přesně.
 */
export function clipToBox(
  a: [number, number, number],
  b: [number, number, number],
  lo: [number, number, number],
  hi: [number, number, number],
): [number, number] | null {
  let t0 = 0
  let t1 = 1
  for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k]
    if (Math.abs(d) < 1e-12) {
      if (a[k] < lo[k] || a[k] > hi[k]) return null
      continue
    }
    let p = (lo[k] - a[k]) / d
    let q = (hi[k] - a[k]) / d
    if (p > q) { const t = p; p = q; q = t }
    if (p > t0) t0 = p
    if (q < t1) t1 = q
    if (t1 <= t0) return null
  }
  return [t0, t1]
}

/**
 * Ze vzorků „zakryté / viditelné" podél jedné hrany udělá souvislé úseky.
 *
 * Hloubková mapa je rastr, takže hrana ležící na siluetě padá střídavě na pixel s plochou
 * a na pixel s pozadím. Bez úpravy by z jedné čáry vznikla stovka dvoupixelových útržků
 * a výkres by byl nečitelná změť. Proto se vzorky nejdřív vyhladí, skoro jednolitá hrana
 * se vůbec nerozsekává a krátké úseky se přiklopí k delšímu sousedovi TÉTO hrany.
 *
 * Vrací trojice `j0, j1, druh` (indexy vzorků, druh 1 = zakryté).
 */
export function edgeRuns(cls: Uint8Array, total: number, minRun: number): number[] {
  const steps = cls.length
  if (!steps) return []

  if (steps >= 3) {
    const src = cls.slice()
    for (let j = 0; j < steps; j++) {
      const a = src[j > 0 ? j - 1 : 0]
      const b = src[j]
      const c = src[j < steps - 1 ? j + 1 : steps - 1]
      cls[j] = a + b + c >= 2 ? 1 : 0
    }
  }
  let hid = 0
  for (let j = 0; j < steps; j++) hid += cls[j]
  if (hid <= steps * 0.12) cls.fill(0)
  else if (hid >= steps * 0.88) cls.fill(1)

  const runs: number[] = []
  for (let j = 0, j0 = 0; j <= steps; j++) {
    if (j < steps && cls[j] === cls[j0]) continue
    runs.push(j0, j, cls[j0])
    j0 = j
  }

  for (let pass = 0; pass < 3 && runs.length > 3; pass++) {
    let changed = false
    for (let k = 0; k < runs.length; k += 3) {
      if (((runs[k + 1] - runs[k]) / steps) * total >= minRun) continue
      const prev = k >= 3 ? runs[k - 2] - runs[k - 3] : -1
      const next = k + 3 < runs.length ? runs[k + 4] - runs[k + 3] : -1
      if (prev < 0 && next < 0) continue
      const to = prev >= next ? runs[k - 1] : runs[k + 5]
      if (runs[k + 2] === to) continue
      runs[k + 2] = to
      changed = true
    }
    if (!changed) break
    // po přeznačení se sousední úseky téhož druhu spojí
    for (let k = runs.length - 3; k >= 3; k -= 3) {
      if (runs[k + 2] !== runs[k - 1]) continue
      runs[k - 2] = runs[k + 1]
      runs.splice(k, 3)
    }
  }
  return runs
}

/**
 * Promítne hrany modelu z výřezu do os výkresu — vektorová obdoba pohledu, a od chvíle,
 * kdy rastr kreslí jen plochy, JEDINÝ zdroj čar ve výkrese.
 *
 * Kreslí se okraje, zlomy i SILUETY (`meshEdges`), takže obrys dostanou i kulaté sloupy,
 * kabely a zaoblené hrany — ty ostrou hranu nemají a dřív ve výkrese chyběly úplně.
 *
 * Promítnuté čáry se pak slijí (`mergeSegments`): instancované zábradlí jinak vyrobí stovky
 * čar přes sebe. A se zapnutým `occlusion` se každá ještě rozseká na úseky VIDITELNÉ
 * a ZAKRYTÉ — přesně jak se pohled kreslí v CADu, plnou a čárkovanou čarou.
 *
 * Vrací ploché 2D úsečky (u0,v0,u1,v1) ve stejné soustavě jako řez, takže se z nich dá
 * odečíst délka i sklon, dají se kótovat a jdou do DXF.
 */
export interface ProjectedEdges {
  /** ploché 2D úsečky u0, v0, u1, v1 */
  segs: number[]
  /** vzdálenost každé úsečky od roviny řezu (m); jedno číslo na úsečku */
  depth: number[]
}

export function projectSlabEdges(
  root: THREE.Object3D,
  plane: THREE.Plane,
  opts: SectionViewOptions = {},
): { visible: ProjectedEdges; hidden: ProjectedEdges } {
  const empty = {
    visible: { segs: [] as number[], depth: [] as number[] },
    hidden: { segs: [] as number[], depth: [] as number[] },
  }
  const { u, v, n } = planeBasis(plane.normal, opts.up)
  const box = new THREE.Box3().setFromObject(root)
  if (box.isEmpty()) return empty
  const center = box.getCenter(new THREE.Vector3())
  const diag = box.getSize(new THREE.Vector3()).length() || 1
  const origin = plane.projectPoint(center, new THREE.Vector3())

  // Bez výřezu se do hloubky nic neomezuje — rastr taky ukazuje celý model, obrysy by
  // jinak končily v rovině řezu a k pozadí by nesedly.
  const from = opts.slab ? Math.min(opts.slab.from, opts.slab.to) : -diag * 2
  const to = opts.slab ? Math.max(opts.slab.from, opts.slab.to) : diag * 2

  let cu = 0, cv = 0, hu = Infinity, hv = Infinity
  if (opts.clip) {
    const rel = opts.clip.center.clone().sub(origin)
    cu = rel.dot(u); cv = rel.dot(v)
    hu = opts.clip.halfU ?? Infinity
    hv = opts.clip.halfV ?? Infinity
  }

  const loBox: [number, number, number] = [cu - hu, cv - hv, from]
  const hiBox: [number, number, number] = [cu + hu, cv + hv, to]

  /**
   * Měřítko výkresu — okno, do kterého se kreslí. Podle něj se pozná, co je ještě čára
   * a co už je jen tečka: prahy se odvozují od NĚJ, ne od velikosti modelu. Na dvousetmetrovém
   * mostu si můžeš vyříznout dvoumetrový detail a v něm mají smysl i centimetry.
   */
  const rect = opts.rect ?? computeRect(box, origin, u, v, opts)
  const span = Math.max(rect.maxU - rect.minU, rect.maxV - rect.minV, 0.1)
  /**
   * Vyhazují se jen úsečky prakticky nulové délky.
   *
   * Drobty se zahazují až u HOTOVÉHO OBRYSU (`polysFromSegments`), protože teprve tam je
   * poznat, jestli krátká hrana patří k něčemu většímu. Filtrovat je tady po kouscích
   * utrhalo lampě nebo sloupku půlku hran a zbyly z nich cáry.
   */
  const minSeg = span * 1e-5

  // ── promítnutí hran ─────────────────────────────────────────────────────────
  const raw: number[] = []
  const edgeAngle = opts.edgeAngle ?? 25
  const P = new THREE.Vector3()
  const Q = new THREE.Vector3()
  const dLocal = new THREE.Vector3()
  root.updateWorldMatrix(true, true)
  root.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return
    const set = meshEdges(mesh.geometry as THREE.BufferGeometry, edgeAngle)
    if (!set.count) return

    forEachInstance(mesh, matrix => {
      viewDirLocal(matrix, n, dLocal)
      for (let e = 0; e < set.count; e++) {
        if (!set.always[e] && !isSilhouette(set, e, dLocal.x, dLocal.y, dLocal.z)) continue
        const o6 = e * 6
        P.set(set.pos[o6], set.pos[o6 + 1], set.pos[o6 + 2]).applyMatrix4(matrix).sub(origin)
        Q.set(set.pos[o6 + 3], set.pos[o6 + 4], set.pos[o6 + 5]).applyMatrix4(matrix).sub(origin)
        const an = P.dot(n)
        const bn = Q.dot(n)
        // hrana se OŘEŽE na výřez a na okno výkresu, ne jen zahodí, když je celá venku
        const au = P.dot(u), av = P.dot(v)
        const bu = Q.dot(u), bv = Q.dot(v)
        const t = clipToBox([au, av, an], [bu, bv, bn], loBox, hiBox)
        if (!t) continue
        const [t0, t1] = t
        raw.push(
          au + (bu - au) * t0, av + (bv - av) * t0, an + (bn - an) * t0,
          au + (bu - au) * t1, av + (bv - av) * t1, an + (bn - an) * t1,
        )
      }
    })
  })
  if (!raw.length) return empty

  // ── slití duplicit ──────────────────────────────────────────────────────────
  const joined = mergeSegments(raw, {
    /**
     * `tol` je zároveň MEZ POVOLENÉHO POSUNU čáry, takže musí být hodně těsná.
     *
     * Slévají se jen skutečné duplicity (táž hrana z instancí) a kousky téže hrany
     * rozsekané tesselací — ty na sebe navazují přesně, na desetiny milimetru. Volnější
     * mez by povolila slít dvě různé, jen skoro rovnoběžné čáry, a jedna z nich by se
     * ve výkrese octla jinde, než ve skutečnosti je.
     */
    tol: Math.max(span * 2e-6, 1e-5),
    // hloubka se rozlišuje hruběji: jde o to nespojit dva prvky za sebou, ne o přesnost
    depthTol: Math.max(span * 2e-3, 0.02),
  })
  // filtruje se AŽ PO slití — z pár krátkých kousků na jedné přímce bývá jedna pořádná čára
  const merged: number[] = []
  for (let i = 0; i + 5 < joined.length; i += 6) {
    if (Math.hypot(joined[i + 3] - joined[i], joined[i + 4] - joined[i + 1]) < minSeg) continue
    for (let k = 0; k < 6; k++) merged.push(joined[i + k])
  }

  // ── rozdělení na viditelné a zakryté ────────────────────────────────────────
  const depth = opts.occlusion ? renderDepthMap(root, opts, { u, v, n, box, diag, origin }) : null

  const visible: ProjectedEdges = { segs: [], depth: [] }
  const hidden: ProjectedEdges = { segs: [], depth: [] }
  const emit = (into: ProjectedEdges, u0: number, v0: number, u1: number, v1: number, nn: number) => {
    into.segs.push(u0, v0, u1, v1)
    into.depth.push(nn)
  }
  if (!depth) {
    for (let i = 0; i + 5 < merged.length; i += 6) {
      emit(visible, merged[i], merged[i + 1], merged[i + 3], merged[i + 4], (merged[i + 2] + merged[i + 5]) / 2)
    }
    return { visible, hidden }
  }

  const { data, w, h, rect: dRect, dist, near, far } = depth
  /**
   * Tolerance v metrech. Hrany leží PŘESNĚ na plochách, ze kterých pocházejí, takže bez ní
   * by se každá druhá prohlásila za zakrytou sama sebou.
   *
   * Odvozuje se od HRUBOSTI HLOUBKOVÉ MAPY, ne od velikosti modelu: chyba vzniká tím, že
   * pixel u siluety vzorkuje plochu o kousek vedle, a ta je řádu jednoho pixelu. Dokud se
   * počítala z úhlopříčky modelu, vycházela na dvousetmetrovém mostu na 40 cm — všechno,
   * co stálo do půl metru za jinou plochou, se pak hlásilo jako viditelné.
   *
   * Druhý člen je k tomu úmyslný: prvek, který je jen kousíček za jiným (madlo zábradlí
   * projde za vlastním sloupkem), se v měřítku výkresu bere pořád za viditelný. Rýsuje se
   * to tak — čára se kvůli pár centimetrům nepřerušuje.
   */
  const biasM = Math.max(((dRect.maxU - dRect.minU) / w) * 4, span * 3e-3, 0.02)
  const bias = biasM / (far - near)
  const pxU = (dRect.maxU - dRect.minU) / w
  const pxV = (dRect.maxV - dRect.minV) / h
  /** hloubka v daném místě; mimo mapu = „nic tam nestojí" */
  const sample = (uu: number, vv: number): number => {
    const x = Math.floor((uu - dRect.minU) / pxU)
    const y = Math.floor((vv - dRect.minV) / pxV)
    if (x < 0 || y < 0 || x >= w || y >= h) return 1
    return unpackDepth(data, (y * w + x) * 4)
  }

  /**
   * Zakrytá je hrana jen tehdy, když je něco blíž po OBOU jejích stranách.
   *
   * Vzorkovat přímo na hraně nejde. Hrana leží na okraji tělesa, takže její pixel padne
   * jednou dovnitř a jednou ven — a dovnitř znamená na vlastní přední plochu, která je
   * u kulatého sloupu o celý poloměr blíž. Sloup tak dostal jednu stranu čárkovanou a druhou
   * plnou, podle toho, kam který okraj zaokrouhlil. Proto se vzorkuje KOLMO na hranu, po
   * obou stranách, a rozhoduje ta vzdálenější: na siluetě je z jedné strany pozadí, takže
   * se čára nepřeruší, ale prvek schovaný za deskou má blíž ležící plochu z obou stran.
   */
  const isHidden = (uu: number, vv: number, nn: number, offU: number, offV: number): boolean => {
    const back = Math.max(sample(uu + offU, vv + offV), sample(uu - offU, vv - offV))
    return isOccluded((dist - nn - near) / (far - near), back, bias)
  }

  /**
   * Nejkratší úsek, který má smysl vydat. Vzorkuje se po pixelech, takže na siluetě jinak
   * vzniká hromada dvoupixelových útržků — ty výkres jen zaplevelí a v DXF jsou na obtíž.
   */
  const minRun = Math.max(span * 4e-3, minSeg)

  for (let i = 0; i + 5 < merged.length; i += 6) {
    const au = merged[i], av = merged[i + 1], an = merged[i + 2]
    const bu = merged[i + 3], bv = merged[i + 4], bn = merged[i + 5]
    const total = Math.hypot(bu - au, bv - av)
    const px = Math.hypot(
      ((bu - au) / (dRect.maxU - dRect.minU)) * w,
      ((bv - av) / (dRect.maxV - dRect.minV)) * h,
    )
    // vzorkuje se po ~3 px, ale nejvýš 48× — na hrubost hloubkové mapy to bohatě stačí
    const steps = Math.max(1, Math.min(48, Math.ceil(px / 3)))
    const uAt = (t: number) => au + (bu - au) * t
    const vAt = (t: number) => av + (bv - av) * t

    // odsazení vzorku kolmo na hranu, o něco přes pixel hloubkové mapy
    const len = Math.hypot(bu - au, bv - av) || 1
    const offU = (-(bv - av) / len) * pxU * 1.3
    const offV = ((bu - au) / len) * pxV * 1.3

    const cls = new Uint8Array(steps)
    for (let j = 0; j < steps; j++) {
      const t = (j + 0.5) / steps
      cls[j] = isHidden(uAt(t), vAt(t), an + (bn - an) * t, offU, offV) ? 1 : 0
    }
    const runs = edgeRuns(cls, total, minRun)

    for (let k = 0; k < runs.length; k += 3) {
      const t0 = runs[k] / steps
      const t1 = runs[k + 1] / steps
      const nMid = an + (bn - an) * ((t0 + t1) / 2)
      emit(runs[k + 2] ? hidden : visible, uAt(t0), vAt(t0), uAt(t1), vAt(t1), nMid)
    }
  }
  return { visible, hidden }
}

/**
 * Vykreslí pohled do roviny řezu. Vrací `null`, když není co kreslit nebo chybí WebGL.
 */
export function renderSectionView(root: THREE.Object3D, plane: THREE.Plane, opts: SectionViewOptions = {}): SectionView | null {
  const t0 = performance.now()
  const gl = getRenderer()
  if (!gl) return null

  const { u, v, n } = planeBasis(plane.normal, opts.up)
  const box = new THREE.Box3().setFromObject(root)
  if (box.isEmpty()) return null
  const center = box.getCenter(new THREE.Vector3())
  const diag = box.getSize(new THREE.Vector3()).length() || 1
  // stejný počátek jako u řezu, jinak by obrázek s obrysem nelícoval
  const origin = plane.projectPoint(center, new THREE.Vector3())

  // ořez na stejné okno, jaké má řez — ať pohled ukazuje přesně vybranou část
  const rect = opts.rect ?? computeRect(box, origin, u, v, opts)
  const w = rect.maxU - rect.minU
  const h = rect.maxV - rect.minV
  if (!(w > 0) || !(h > 0)) return null

  // strop bere z karty, ne z odhadu — na slabším stroji je maxTextureSize klidně 4096
  const cap = gl.capabilities?.maxTextureSize ?? 4096
  const size = Math.max(400, Math.min(cap, opts.size ?? 4096))
  const pxPerM = size / Math.max(w, h)
  const widthPx = Math.max(1, Math.round(w * pxPerM))
  const heightPx = Math.max(1, Math.round(h * pxPerM))

  const paper = !!opts.paper
  // plochy jsou podklad pod vektorové čáry: dost světlé, aby daly tvar, ne aby přehlušily
  const built = prepareScene(root, paper ? 0xd2d8de : 0x46566f)

  // kamera stojí na kladné straně normály a dívá se na rovinu; `up = v` dá vodorovnou osu `u`
  const { cam } = viewCamera(rect, origin, v, n, diag)

  // bez zadaného výřezu se ořízne jen zadní strana, ať se nekreslí to, co je za rovinou řezu
  const from = opts.slab ? Math.min(opts.slab.from, opts.slab.to) : 0
  const to = opts.slab ? Math.max(opts.slab.from, opts.slab.to) : diag * 2
  const clip = slabPlanes(origin, n, from, to)

  const prevClip = gl.clippingPlanes
  try {
    gl.clippingPlanes = clip
    built.light.position.copy(cam.position).addScaledVector(u, diag * 0.4).addScaledVector(v, diag * 0.6)
    built.light.target.position.copy(origin)
    built.light.target.updateMatrixWorld()
    gl.setSize(widthPx, heightPx, false)
    gl.setClearAlpha(0)
    gl.clear()
    gl.render(built.scene, cam)
    const url = gl.domElement.toDataURL('image/png')
    return { url, widthPx, heightPx, rect, pxPerM, ms: performance.now() - t0 }
  } catch (e) {
    console.error('Pohled do řezu se nepodařilo vykreslit:', e)
    return null
  } finally {
    // scéna se NERUŠÍ — drží se u modelu a příště se jen znovu vykreslí
    gl.clippingPlanes = prevClip
  }
}
