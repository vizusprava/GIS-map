/*------------------------------------------------------------------------------
	PANELÁK - parametrický scripted plugin pro 3ds Max
	--------------------------------------------------
	Vytvoří objekt "Panelák" v Create > Geometry > kategorie "Panelák".
	Všechny rozměry se mění kdykoliv později v Modify panelu (slidery + spinnery),
	model se přepočítá v reálném čase.

	Rozměry jsou zadávané v METRECH. Pokud máte scénu v cm / mm, nastavte
	v rollupu "Materiál a mapování" hodnotu "1 m = ... jednotek" (100 pro cm,
	1000 pro mm).

	Použití:
		1) MAXScript > Run Script...  ->  panelak.ms
		2) Create panel > Geometry > rozbalovací seznam "Panelák" > tlačítko Panelák
		   (tahem v pohledu), nebo v Listeneru:  PanelakGeo()
		3) Modify panel -> parametry

	Materiál: tlačítko "Vytvořit a přiřadit materiál" udělá Multi/Sub-Object
	materiál se správnými ID (fasáda, sokl, sklo, rámy, zábradlí, desky,
	střecha, dveře).

	Model je jeden mesh - pro další ruční úpravy ho převeďte na Editable Poly.
------------------------------------------------------------------------------*/

-- ID materiálů (Multi/Sub-Object)
global PNL_MAT_FASADA  = 1
global PNL_MAT_SOKL    = 2
global PNL_MAT_SKLO    = 3
global PNL_MAT_RAM     = 4
global PNL_MAT_ZABRADLI = 5
global PNL_MAT_DESKA   = 6
global PNL_MAT_STRECHA = 7
global PNL_MAT_DVERE   = 8
-- 9 az 13 patri verzi s interierem (panelak-interier.ms)
global PNL_MAT_ZABRADLI2 = 14
global PNL_MAT_ZABRADLI3 = 15
global PNL_MAT_ZABRADLI4 = 16
global PNL_MAT_AKCENT1   = 17
global PNL_MAT_AKCENT2   = 18
global PNL_MAT_SVIT1     = 19
global PNL_MAT_SVIT2     = 20
global PNL_MAT_SPARA     = 21
global PNL_MAT_KLEMP     = 22
global PNL_MAT_DROBNOSTI = 23

-- dopredne deklarace (rollouty je volaji driv, nez jsou definovane)
global panelakMaterial
global panelakToPoly
global panelakLosuj
global pnl_setParam

-- kontejner na geometrii (pole jsou v MAXScriptu předávaná odkazem)
-- S = hladicí skupina faceu: 0 = ostře lomené, 2 = plášť trubky (hladký)
struct pnl_ctx ( V = #(), F = #(), M = #(), TV = #(), TF = #(), S = #() )

/*--- kvádr: 8 vertexů, 12 trojúhelníků, world-aligned box mapping -----------*/
fn pnl_addBox cx qx1 qy1 qz1 qx2 qy2 qz2 mid uv =
(
	local x1 = amin qx1 qx2, x2 = amax qx1 qx2
	local y1 = amin qy1 qy2, y2 = amax qy1 qy2
	local z1 = amin qz1 qz2, z2 = amax qz1 qz2
	if (x2 - x1) > 1e-5 and (y2 - y1) > 1e-5 and (z2 - z1) > 1e-5 do
	(
		local o = cx.V.count
		local P = #( [x1,y1,z1], [x2,y1,z1], [x2,y2,z1], [x1,y2,z1], \
					 [x1,y1,z2], [x2,y1,z2], [x2,y2,z2], [x1,y2,z2] )
		for p in P do append cx.V p
		-- každá položka: 4 rohy stěny + dvojice os pro UV (1=X, 2=Y, 3=Z)
		local Q = #( #(1,4,3,2, 1,2), #(5,6,7,8, 1,2), #(1,2,6,5, 1,3), \
					 #(2,3,7,6, 2,3), #(3,4,8,7, 1,3), #(4,1,5,8, 2,3) )
		local useUV = uv > 0
		for q in Q do
		(
			local tb = cx.TV.count
			if useUV do
				for k = 1 to 4 do
				(
					local pp = P[q[k]]
					append cx.TV [ pp[q[5]] / uv, pp[q[6]] / uv, 0 ]
				)
			append cx.F [ o + q[1], o + q[2], o + q[3] ]
			append cx.F [ o + q[1], o + q[3], o + q[4] ]
			if useUV do
			(
				append cx.TF [ tb + 1, tb + 2, tb + 3 ]
				append cx.TF [ tb + 1, tb + 3, tb + 4 ]
			)
			append cx.M mid
			append cx.M mid
			append cx.S 0
			append cx.S 0
		)
	)
	ok
)

/*--- trubka mezi dvěma body -------------------------------------------------
	Libovolný směr, ne jen podél os - kvůli šikmým madlům u schodů.
	Plášť dostane hladicí skupinu 2, čela zůstanou ostrá.                   */
fn pnl_addPipe2 cx pa pb r sides mid uvs =
(
	local ns = amax 3 (amin sides 24)
	local dvec = pb - pa
	local dlen = length dvec
	if dlen > 1e-5 and r > 1e-6 do
	(
		local dnm = dvec / dlen
		-- pomocná osa nesmí být rovnoběžná se směrem trubky
		local upv = if (abs dnm.z) > 0.9 then [1, 0, 0] else [0, 0, 1]
		local fax = normalize (cross upv dnm)
		local fay = normalize (cross dnm fax)
		local o = cx.V.count
		local RU = #()
		local RV = #()
		for k = 1 to ns do
		(
			local ang = 360.0 * (k - 1) / ns
			append RU (r * (cos ang))
			append RV (r * (sin ang))
		)
		for k = 1 to ns do
		(
			local ofs = fax * RU[k] + fay * RV[k]
			append cx.V (pa + ofs)
			append cx.V (pb + ofs)
		)
		local circ = 2.0 * pi * r
		-- plášť
		for k = 1 to ns do
		(
			local m = ((mod k ns) as integer) + 1
			local b1 = o + 2 * k - 1
			local t1 = o + 2 * k
			local b2 = o + 2 * m - 1
			local t2 = o + 2 * m
			append cx.F [b1, b2, t2]
			append cx.F [b1, t2, t1]
			append cx.M mid
			append cx.M mid
			append cx.S 2
			append cx.S 2
			if uvs > 0 do
			(
				local tb = cx.TV.count
				local u1 = circ * (k - 1) / ns / uvs
				local u2 = circ * k / ns / uvs
				append cx.TV [u1, 0, 0]
				append cx.TV [u2, 0, 0]
				append cx.TV [u2, dlen / uvs, 0]
				append cx.TV [u1, dlen / uvs, 0]
				append cx.TF [tb + 1, tb + 2, tb + 3]
				append cx.TF [tb + 1, tb + 3, tb + 4]
			)
		)
		-- čela
		for k = 2 to ns - 1 do
		(
			append cx.F [o + 1, o + 2 * (k + 1) - 1, o + 2 * k - 1]
			append cx.M mid
			append cx.S 0
			if uvs > 0 do
			(
				local tb = cx.TV.count
				append cx.TV [RU[1] / uvs, RV[1] / uvs, 0]
				append cx.TV [RU[k + 1] / uvs, RV[k + 1] / uvs, 0]
				append cx.TV [RU[k] / uvs, RV[k] / uvs, 0]
				append cx.TF [tb + 1, tb + 2, tb + 3]
			)
			append cx.F [o + 2, o + 2 * k, o + 2 * (k + 1)]
			append cx.M mid
			append cx.S 0
			if uvs > 0 do
			(
				local tb = cx.TV.count
				append cx.TV [RU[1] / uvs, RV[1] / uvs, 0]
				append cx.TV [RU[k] / uvs, RV[k] / uvs, 0]
				append cx.TV [RU[k + 1] / uvs, RV[k + 1] / uvs, 0]
				append cx.TF [tb + 1, tb + 2, tb + 3]
			)
		)
	)
	ok
)

/*--- trubka rovnoběžná s osou (zkratka nad pnl_addPipe2) --------------------
	axis: 1 = podél X, 2 = podél Y, 3 = podél Z
	a1..a2 je rozsah podél té osy, uu/vv poloha ve zbylých dvou
	(axis 1: uu=Y vv=Z,  axis 2: uu=X vv=Z,  axis 3: uu=X vv=Y)             */
fn pnl_addPipe cx axis a1 a2 uu vv r sides mid uvs =
(
	local pa = [0, 0, 0]
	local pb = [0, 0, 0]
	case axis of
	(
		1: ( pa = [a1, uu, vv]; pb = [a2, uu, vv] )
		2: ( pa = [uu, a1, vv]; pb = [uu, a2, vv] )
		default: ( pa = [uu, vv, a1]; pb = [uu, vv, a2] )
	)
	pnl_addPipe2 cx pa pb r sides mid uvs
)

fn pnl_cmpSeg a b = ( if a.x < b.x then -1 else if a.x > b.x then 1 else 0 )

/*--- stěna s otvory ---------------------------------------------------------
	Vrací seznam obdélníků [a1,a2,z1,z2], které vyplní plochu a1..a2 / z1..z2
	mimo zadané otvory (point4 [a1,a2,z1,z2]).                                */
fn pnl_wallRects a1 a2 z1 z2 ops =
(
	local eps = 1e-4
	local res = #()
	local zs = #( z1, z2 )
	for o in ops do
	(
		local q1 = amax o.z z1
		local q2 = amin o.w z2
		if q2 > q1 + eps do ( appendIfUnique zs q1; appendIfUnique zs q2 )
	)
	sort zs
	for i = 1 to zs.count - 1 do
	(
		local za = zs[i]
		local zc = zs[i+1]
		if zc - za > eps do
		(
			local zm = (za + zc) * 0.5
			local seg = #()
			for o in ops do
				if o.z < zm and o.w > zm do
				(
					local s1 = amax o.x a1
					local s2 = amin o.y a2
					if s2 > s1 + eps do append seg [s1, s2]
				)
			qsort seg pnl_cmpSeg
			local cur = a1
			for s in seg do
			(
				if s.x > cur + eps do append res [cur, s.x, za, zc]
				if s.y > cur do cur = s.y
			)
			if a2 > cur + eps do append res [cur, a2, za, zc]
		)
	)
	res
)

/*--- otvory jedné fasády (okna, balkonové dveře, vstupy) --------------------*/
fn pnl_facadeOps AX n ow oh par zb fh NF bFrom balcAx wantBalc balcDoors EX ne dw dh mrg =
(
	local ops = #()
	local kinds = #()
	for f = 1 to NF do
	(
		local zf = zb + (f - 1) * fh
		for i = 1 to n do
		(
			local xc = AX[i]
			local isB = wantBalc and f >= bFrom and (findItem balcAx i) > 0
			if isB and balcDoors then
			(
				append ops [ xc - ow*0.5, xc + ow*0.5, zf + mrg*0.2, zf + par + oh ]
				append kinds 2
			)
			else
			(
				append ops [ xc - ow*0.5, xc + ow*0.5, zf + par, zf + par + oh ]
				append kinds 1
			)
		)
	)
	if ne > 0 do
		for e = 1 to ne do
		(
			append ops [ EX[e] - dw*0.5, EX[e] + dw*0.5, zb, zb + dh ]
			append kinds 3
		)
	-- okna v přízemí, která kolidují se vstupem, zahodíme
	local o2 = #()
	local k2 = #()
	for j = 1 to ops.count do
	(
		local o = ops[j]
		local drop = false
		if kinds[j] != 3 and ne > 0 and o.z < zb + dh do
			for e = 1 to ne do
				if o.x < EX[e] + dw*0.5 + mrg and o.y > EX[e] - dw*0.5 - mrg do drop = true
		if not drop do ( append o2 o; append k2 kinds[j] )
	)
	#( o2, k2 )
)

/*--- pseudonáhoda 0..1 odvozená z polohy ------------------------------------
	Schválně se nepoužívá random: hodnota musí vyjít pokaždé stejně, jinak by
	se model měnil při každém přepočtu. Stejná poloha = stejná hodnota.     */
fn pnl_hash a b seed =
(
	local v = (sin (a * 12.9898 + b * 78.233 + seed * 3.17)) * 43758.5453
	v - (floor v)
)

/*--- mapa balkonů -----------------------------------------------------------
	Vrátí pole [podlaží][osa] s hodnotou 0 = žádný, 1 = vpředu, 2 = vzadu,
	3 = z obou stran. Ze stejné mapy se pak staví balkony i balkonové dveře,
	takže spolu vždycky sedí.
	vzor: 1 všechny osy, 2 svislé pásy (nad sebou), 3 šachovnice (zig-zag),
	      4 diagonála (posun o osu každé patro), 5 dvojice s mezerou,
	      6 náhodně podle seedu
	strany: 2 vpředu, 3 vzadu, 4 z obou stran (shodné s parametrem "balkony") */
fn pnl_balcMap n NF vzor krok odPatra hustota strany stridat seed =
(
	local base = 0
	case strany of
	(
		2: base = 1
		3: base = 2
		4: base = 3
		default: base = 0
	)
	local kr = amax 1 krok
	local m = #()
	for f = 1 to NF do
	(
		local row = #()
		for i = 1 to n do
		(
			local v = false
			if f >= odPatra and base > 0 do
			(
				case vzor of
				(
					1: v = true
					2: v = ((mod (i - 1) kr) < 0.5)
					3: v = ((mod (i + f) 2) < 0.5)
					4: v = ((mod (i - 1 + f - 1) kr) < 0.5)
					5: v = ((mod (i - 1) (kr + 1)) < 1.5)
					default: v = ((pnl_hash (i * 7.3) (f * 11.7) seed) < hustota)
				)
			)
			local val = 0
			if v do
			(
				val = base
				if stridat and base == 3 do
					val = (if ((mod (i + f) 2) < 0.5) then 1 else 2)
			)
			append row val
		)
		append m row
	)
	m
)

/*--- barva zábradlí jednoho balkonu -----------------------------------------
	rezim: 1 jedna barva, 2 po sloupcích, 3 po patrech, 4 šikmé pruhy,
	       5 náhodně                                                        */
fn pnl_balcMat f i rezim pocet seed =
(
	local ids = #(PNL_MAT_ZABRADLI, PNL_MAT_ZABRADLI2, PNL_MAT_ZABRADLI3, PNL_MAT_ZABRADLI4)
	local np = amax 1 (amin pocet 4)
	local k = 0
	case rezim of
	(
		2: k = ((mod (i - 1) np) as integer)
		3: k = ((mod (f - 1) np) as integer)
		4: k = ((mod (i + f) np) as integer)
		5: k = ((floor ((pnl_hash (i * 3.1) (f * 5.7) (seed + 17)) * np)) as integer)
		default: k = 0
	)
	if k < 0 do k = 0
	if k > np - 1 do k = np - 1
	ids[k + 1]
)

/*--- materiál jednoho kusu fasády -------------------------------------------
	vzor: 1 bez akcentů, 2 náhodné panely, 3 svislé pruhy, 4 vodorovné pásy */
fn pnl_fasadaMat a z vzor hustota bandX bandZ seed =
(
	local res = PNL_MAT_FASADA
	local bx = amax 0.001 bandX
	local bz = amax 0.001 bandZ
	case vzor of
	(
		2: (
			local h = pnl_hash a z seed
			if h < hustota do
				res = (if h < hustota * 0.5 then PNL_MAT_AKCENT1 else PNL_MAT_AKCENT2)
		)
		3: (
			local h = pnl_hash ((floor (a / bx)) * 1.0) 0.0 seed
			if h < hustota do res = PNL_MAT_AKCENT1
		)
		4: (
			local h = pnl_hash 0.0 ((floor (z / bz)) * 1.0) seed
			if h < hustota do res = PNL_MAT_AKCENT2
		)
		default: res = PNL_MAT_FASADA
	)
	res
)

/*--- sklo okna: část oken může "svítit" -------------------------------------
	podil = 0..1 kolik oken je rozsvícených                                 */
fn pnl_skloMat o podil seed =
(
	local res = PNL_MAT_SKLO
	if podil > 0.001 do
	(
		local h = pnl_hash ((o.x + o.y) * 0.5) ((o.z + o.w) * 0.5) (seed + 41)
		if h < podil do
			res = (if h < podil * 0.45 then PNL_MAT_SVIT1 else PNL_MAT_SVIT2)
	)
	res
)

/*--- otvory fasády podle mapy balkonů ---------------------------------------
	side: 1 = přední fasáda, 2 = zadní                                      */
fn pnl_facadeOps2 AX n ow oh par zb fh NF bmap side balcDoors EX ne dw dh mrg =
(
	local ops = #()
	local kinds = #()
	for f = 1 to NF do
	(
		local zf = zb + (f - 1) * fh
		for i = 1 to n do
		(
			local xc = AX[i]
			local bv = 0
			if f <= bmap.count do if i <= bmap[f].count do bv = bmap[f][i]
			local isB = (bv == side or bv == 3)
			if isB and balcDoors then
			(
				append ops [ xc - ow*0.5, xc + ow*0.5, zf + mrg*0.2, zf + par + oh ]
				append kinds 2
			)
			else
			(
				append ops [ xc - ow*0.5, xc + ow*0.5, zf + par, zf + par + oh ]
				append kinds 1
			)
		)
	)
	if ne > 0 do
		for e = 1 to ne do
		(
			append ops [ EX[e] - dw*0.5, EX[e] + dw*0.5, zb, zb + dh ]
			append kinds 3
		)
	local o2 = #()
	local k2 = #()
	for j = 1 to ops.count do
	(
		local o = ops[j]
		local drop = false
		if kinds[j] != 3 and ne > 0 and o.z < zb + dh do
			for e = 1 to ne do
				if o.x < EX[e] + dw*0.5 + mrg and o.y > EX[e] - dw*0.5 - mrg do drop = true
		if not drop do ( append o2 o; append k2 kinds[j] )
	)
	#( o2, k2 )
)

/*--- kvádr v souřadnicích stěny ---------------------------------------------
	a = podél stěny, p = do hloubky (kolmo k fasádě), z = výška.
	horiz = true  -> stěna leží v rovině XZ (čelní a zadní fasáda)
	horiz = false -> stěna leží v rovině YZ (štíty)                         */
fn pnl_boxW cx horiz a1 a2 p1 p2 z1 z2 mid uv =
(
	if horiz then pnl_addBox cx a1 p1 z1 a2 p2 z2 mid uv
	else pnl_addBox cx p1 a1 z1 p2 a2 z2 mid uv
	ok
)

/*--- nastavení detailů výplní otvorů ----------------------------------------
	Všechny rozměry se sem ukládají už přepočítané na jednotky scény.       */
struct pnl_det
(
	U = 1.0,
	ramy = true,
	ram = 0.07,             -- šířka rámu
	zapusteni = 0.14,       -- zapuštění zasklení pod líc fasády
	deleni = 2,             -- počet křídel okna
	nadsvetlik = false,     -- horní světlík nad oknem
	nadsvetlikV = 0.45,
	parapetPlech = true,    -- vnější parapetní plech
	parapetTl = 0.04,
	parapetPresah = 0.07,
	balkonParapet = 0.85,   -- výška parapetu u pevné části balkonových dveří
	dverKridla = 2,         -- vstupní dveře: počet křídel
	dverNadsvetlik = true,
	dverNadsvetlikV = 0.5
)

/*--- výplň otvoru -----------------------------------------------------------
	kind 1 = okno, 2 = balkonové dveře, 3 = vstupní dveře                   */
fn pnl_fillOpening cx o kind horiz wallPos dir det mGlass uv =
(
	local a1 = o.x, a2 = o.y, z1 = o.z, z2 = o.w
	local U = det.U
	if (a2 - a1) > 0.1 * U and (z2 - z1) > 0.1 * U do
	(
		local fw = if det.ramy then det.ram else 0.0
		local pa = wallPos + dir * det.zapusteni            -- líc zasklení
		local gt = amax (0.02 * U) (fw * 0.6)
		local pb = pa + dir * gt
		local qa = pa - dir * (amax (0.02 * U) (fw * 0.4))  -- rám: mírně před sklem
		local qb = pa + dir * (amax (0.03 * U) (fw * 0.9))
		-- rámy a křídla vstupních dveří mají svůj materiál, ale zasklení je sklo
		local mR = if kind == 3 then PNL_MAT_DVERE else PNL_MAT_RAM
		local mG = mGlass

		-- zasklení přes celý otvor; rámy a sloupky se kladou před něj
		pnl_boxW cx horiz (a1 + fw) (a2 - fw) pa pb (z1 + fw) (z2 - fw) mG uv

		-- obvodový rám
		if det.ramy do
		(
			pnl_boxW cx horiz a1 (a1 + fw) qa qb z1 z2 mR uv
			pnl_boxW cx horiz (a2 - fw) a2 qa qb z1 z2 mR uv
			pnl_boxW cx horiz (a1 + fw) (a2 - fw) qa qb z1 (z1 + fw) mR uv
			pnl_boxW cx horiz (a1 + fw) (a2 - fw) qa qb (z2 - fw) z2 mR uv
		)

		case kind of
		(
			2:	/*--- balkonové dveře: křídlo + pevné okno s parapetem ---*/
			(
				local dvW = amin (0.95 * U) ((a2 - a1) * 0.55)
				local am = a1 + dvW
				local zs = z1 + (amin det.balkonParapet ((z2 - z1) * 0.45))
				-- parapetní panel pod pevnou částí
				pnl_boxW cx horiz am (a2 - fw) qa qb (z1 + fw) zs PNL_MAT_FASADA uv
				if det.ramy do
				(
					-- sloupek mezi dveřmi a oknem
					pnl_boxW cx horiz (am - fw * 0.5) (am + fw * 0.5) qa qb (z1 + fw) (z2 - fw) mR uv
					-- příčka nad parapetem
					pnl_boxW cx horiz am (a2 - fw) qa qb (zs - fw * 0.45) (zs + fw * 0.45) mR uv
					-- spodní rám dveřního křídla
					pnl_boxW cx horiz (a1 + fw) (am - fw * 0.5) qa qb (z1 + fw) (z1 + fw * 3) mR uv
					-- klika
					pnl_boxW cx horiz (am - fw * 2.4) (am - fw * 1.2) (qa - dir * fw * 0.9) qa \
						(z1 + (z2 - z1) * 0.44) (z1 + (z2 - z1) * 0.56) PNL_MAT_KLEMP uv
				)
				if det.parapetPlech do
				(
					-- parapet jen u pevné části, práh u dveřní
					pnl_boxW cx horiz am (a2 + det.parapetPresah) \
						(wallPos - dir * det.parapetPresah) (pa + dir * fw) (zs - det.parapetTl) zs PNL_MAT_KLEMP uv
					pnl_boxW cx horiz a1 am \
						(wallPos - dir * det.parapetPresah * 0.5) (pa + dir * fw) (z1 - det.parapetTl) z1 PNL_MAT_KLEMP uv
				)
			)
			3:	/*--- vstupní dveře: křídla, nadsvětlík, madla ---*/
			(
				local nsv = if det.dverNadsvetlik then (amin det.dverNadsvetlikV ((z2 - z1) * 0.28)) else 0.0
				local zt = z2 - nsv
				if det.ramy do
				(
					if nsv > 0.02 * U do
						pnl_boxW cx horiz (a1 + fw) (a2 - fw) qa qb (zt - fw * 0.6) (zt + fw * 0.6) mR uv
					local nk = amax 1 det.dverKridla
					local kw = (a2 - a1) / nk
					for k = 1 to nk - 1 do
					(
						local am = a1 + kw * k
						pnl_boxW cx horiz (am - fw * 0.6) (am + fw * 0.6) qa qb (z1 + fw) zt mR uv
					)
					for k = 1 to nk do
					(
						local ka = a1 + kw * (k - 1)
						local kb = ka + kw
						-- spodní neprůhledný panel křídla
						pnl_boxW cx horiz (ka + fw) (kb - fw) qa qb (z1 + fw) \
							(z1 + (amin (0.45 * U) ((zt - z1) * 0.3))) mR uv
						-- svislé madlo u středu
						local hx = if (mod k 2) > 0.5 then (kb - fw * 4.0) else (ka + fw * 3.0)
						pnl_boxW cx horiz hx (hx + fw) (qa - dir * fw * 1.3) qa \
							(z1 + (zt - z1) * 0.34) (z1 + (zt - z1) * 0.62) PNL_MAT_KLEMP uv
					)
				)
			)
			default:	/*--- okno: sloupky, nadsvětlík, parapet ---*/
			(
				if det.ramy do
				(
					local nd = amax 1 det.deleni
					for k = 1 to nd - 1 do
					(
						local am = a1 + (a2 - a1) * k / nd
						pnl_boxW cx horiz (am - fw * 0.45) (am + fw * 0.45) qa qb (z1 + fw) (z2 - fw) mR uv
					)
					if det.nadsvetlik do
					(
						local zn = z2 - (amin det.nadsvetlikV ((z2 - z1) * 0.4))
						if zn > z1 + fw * 2 do
							pnl_boxW cx horiz (a1 + fw) (a2 - fw) qa qb (zn - fw * 0.45) (zn + fw * 0.45) mR uv
					)
				)
				if det.parapetPlech do
					pnl_boxW cx horiz (a1 - det.parapetPresah) (a2 + det.parapetPresah) \
						(wallPos - dir * det.parapetPresah) (pa + dir * fw) (z1 - det.parapetTl) z1 PNL_MAT_KLEMP uv
			)
		)
	)
	ok
)

/*--- spáry mezi panely na jedné stěně ---------------------------------------*/
fn pnl_spary cx horiz a1 a2 wallPos dir z1 z2 krokA krokZ sirka vylez uv =
(
	local p1 = wallPos - dir * vylez
	local p2 = wallPos + dir * (vylez * 0.25)
	local na = ((floor ((a2 - a1) / krokA + 0.001)) as integer)
	for k = 0 to na do
	(
		local aa = a1 + krokA * k
		if aa < a2 + 0.001 do
			pnl_boxW cx horiz (aa - sirka * 0.5) (aa + sirka * 0.5) p1 p2 z1 z2 PNL_MAT_SPARA uv
	)
	local nz = ((floor ((z2 - z1) / krokZ + 0.001)) as integer)
	for k = 0 to nz do
	(
		local zz = z1 + krokZ * k
		pnl_boxW cx horiz a1 a2 p1 p2 (zz - sirka * 0.5) (zz + sirka * 0.5) PNL_MAT_SPARA uv
	)
	ok
)

/*--- jeden balkon -----------------------------------------------------------*/
fn pnl_balkon cx xc yw dir zf bw bd bs rh rt style krok mRail uv =
(
	local xa = xc - bw * 0.5
	local xb = xc + bw * 0.5
	local ye = yw + dir * bd                        -- vnější hrana balkonu
	local ymin = amin (yw - dir * bs) ye
	local ymax = amax (yw - dir * bs) ye
	-- nosná deska (mírně zapuštěná do stěny)
	pnl_addBox cx xa ymin (zf - bs) xb ymax zf PNL_MAT_DESKA uv
	local zr = zf + rh
	local yr1 = amin (ye - dir * rt) ye
	local yr2 = amax (ye - dir * rt) ye
	case style of
	(
		1:	-- plné zábradlí
		(
			pnl_addBox cx xa yr1 zf xb yr2 zr mRail uv
			pnl_addBox cx xa ymin zf (xa + rt) ymax zr mRail uv
			pnl_addBox cx (xb - rt) ymin zf xb ymax zr mRail uv
		)
		2:	-- svislé tyče + madlo
		(
			local bt = rt * 0.45
			local kk = amax (bt * 2.0) krok
			pnl_addBox cx xa yr1 (zr - bt * 2) xb yr2 zr mRail uv
			pnl_addBox cx xa ymin (zr - bt * 2) (xa + bt * 2) ymax zr mRail uv
			pnl_addBox cx (xb - bt * 2) ymin (zr - bt * 2) xb ymax zr mRail uv
			local c1 = amax 2 ((floor (bw / kk)) as integer)
			for q = 0 to c1 do
			(
				local xx = amin (xb - bt) (amax xa (xa + bw * q / c1 - bt * 0.5))
				pnl_addBox cx xx yr1 zf (xx + bt) yr2 zr mRail uv
			)
			local c2 = amax 1 ((floor (bd / kk)) as integer)
			for q = 0 to c2 do
			(
				local yy = amin (ymax - bt) (amax ymin (ymin + (ymax - ymin) * q / c2 - bt * 0.5))
				pnl_addBox cx xa yy zf (xa + bt) (yy + bt) zr mRail uv
				pnl_addBox cx (xb - bt) yy zf xb (yy + bt) zr mRail uv
			)
		)
		default:	-- plná parapetní deska + madlo nad ní
		(
			local ph = rh * 0.70
			local zp = zf + ph
			pnl_addBox cx xa yr1 zf xb yr2 zp mRail uv
			pnl_addBox cx xa ymin zf (xa + rt) ymax zp mRail uv
			pnl_addBox cx (xb - rt) ymin zf xb ymax zp mRail uv
			local bt = rt * 0.5
			pnl_addBox cx xa yr1 (zr - bt) xb yr2 zr mRail uv
			pnl_addBox cx xa ymin (zr - bt) (xa + bt * 2) ymax zr mRail uv
			pnl_addBox cx (xb - bt * 2) ymin (zr - bt) xb ymax zr mRail uv
			pnl_addBox cx (xa + bt) yr1 zp (xa + bt * 3) yr2 zr mRail uv
			pnl_addBox cx (xb - bt * 3) yr1 zp (xb - bt) yr2 zr mRail uv
		)
	)
	ok
)

/*============================ scripted plugin ===============================*/
plugin simpleObject PanelakGeo
	name:"Panelák"
	classID:#(0x51ab33c7, 0x2d7f9104)
	category:"Panelák"
	version:1
(
	/*--- vytvoření jedním kliknutím do pohledu ---*/
	tool create
	(
		on mousePoint click do
		(
			nodeTM.translation = gridPoint
			#stop
		)
	)

	/*-------------------------- parametry -------------------------------*/
	parameters pRozmery rollout:rMain
	(
		delka        type:#float   ui:spDelka    default:36.0
		sirka        type:#float   ui:spSirka    default:12.0
		podlazi      type:#integer ui:spPodlazi  default:8
		vyskaPodlazi type:#float   ui:spVyskaP   default:2.8
		tlSteny      type:#float   ui:spTlSteny  default:0.3
		soklVyska    type:#float   ui:spSokl     default:0.6
		soklPresah   type:#float   ui:spSoklP    default:0.06
		vnitrniStropy type:#boolean ui:chkStropy default:false
	)

	parameters pFasada rollout:rFasada
	(
		autoOsy    type:#boolean ui:chkAutoOsy               default:true
		rozponOsy  type:#float   ui:spRozpon                 default:3.6
		pocetOsi   type:#integer ui:spOsy                   default:10
		oknoSirka  type:#float   ui:spOknoS                  default:1.8
		oknoVyska  type:#float   ui:spOknoV                  default:1.5
		parapet    type:#float   ui:spParapet                default:0.85
		ramy       type:#boolean ui:chkRamy                  default:true
		ramSirka   type:#float   ui:spRam                    default:0.07
		sklozap    type:#float   ui:spZapusteni              default:0.14
		stitOkna   type:#integer ui:spStitOkna               default:0
	)

	parameters pDetaily rollout:rDetaily
	(
		oknoDeleni     type:#integer ui:spDeleni    default:2
		oknaNadsvetlik type:#boolean ui:chkNadsv    default:false
		parapetPlech   type:#boolean ui:chkParapet  default:true
		dverKridla     type:#integer ui:spKridla    default:2
		spary          type:#boolean ui:chkSpary    default:true
		sparaSirka     type:#float   ui:spSpara     default:0.04
		oplechovani    type:#boolean ui:chkOplech   default:true
		sklepniOkna    type:#boolean ui:chkSklep    default:true
		svody          type:#boolean ui:chkSvody    default:true
		strechaDetail  type:#boolean ui:chkStrDet   default:true
		vstupDetail    type:#boolean ui:chkVstupDet default:true
		trubkaHran     type:#integer ui:spHran     default:8
	)

	parameters pBalkony rollout:rBalkony
	(
		balkony        type:#integer ui:ddlBalkony             default:2
		balkonKrok     type:#integer ui:spKrok                 default:1
		balkonOd       type:#integer ui:spBalkonOd             default:2
		balkonHloubka  type:#float   ui:spBHl                 default:1.5
		balkonSirka    type:#float   ui:spBSir                default:3.0
		balkonDeska    type:#float   ui:spBDeska               default:0.18
		zabradliTyp    type:#integer ui:ddlZabradli            default:1
		zabradliVyska  type:#float   ui:spZabrV                default:1.1
		zabradliTl     type:#float   ui:spZabrT                default:0.1
		tyceKrok       type:#float   ui:spTyce                 default:0.14
		balkonoveDvere type:#boolean ui:chkBalkDvere           default:true
	)

	parameters pVariace rollout:rVariace
	(
		seed          type:#integer ui:spSeed       default:1
		balkonVzor    type:#integer ui:ddlBVzor     default:1
		balkonHustota type:#float   ui:spBHust      default:0.5
		stridatStrany type:#boolean ui:chkStridat   default:false
		zabradliBarvy type:#integer ui:ddlBarvy     default:1
		pocetBarev    type:#integer ui:spPocetBarev default:3
		fasadaVzor    type:#integer ui:ddlFVzor     default:1
		fasadaHustota type:#float   ui:spFHust      default:0.25
		oknaSviti     type:#float   ui:spSviti      default:0.0
	)

	parameters pVstupy rollout:rVstupy
	(
		vchody         type:#integer ui:spVchody              default:2
		vchodyVzadu    type:#boolean ui:chkVchodyVzadu         default:false
		dverSirka      type:#float   ui:spDverS                default:1.8
		dverVyska      type:#float   ui:spDverV                default:2.3
		strisky        type:#boolean ui:chkStriska             default:true
		striskaSirka   type:#float   ui:spStriskaS             default:3.0
		striskaHloubka type:#float   ui:spStriskaH             default:1.4
		striskaTl      type:#float   ui:spStriskaT             default:0.18
		schody         type:#boolean ui:chkSchody              default:true
		schodySirka    type:#float   ui:spSchodyS              default:2.4
		schodyHloubka  type:#float   ui:spSchodyH              default:0.32
	)

	parameters pStrecha rollout:rStrecha
	(
		strechaTl      type:#float   ui:spStrechaT             default:0.3
		atikaVyska     type:#float   ui:spAtikaV               default:0.6
		atikaTl        type:#float   ui:spAtikaT               default:0.25
		strojovna      type:#boolean ui:chkStrojovna           default:true
		strojovnaVyska type:#float   ui:spStrojV               default:2.6
	)

	parameters pMat rollout:rMat
	(
		mapovani  type:#boolean ui:chkMapovani                 default:true
		uvMeritko type:#float   ui:spUV                        default:1.0
		unitsPerM type:#float   ui:spJednotky                  default:1.0
	)

	/*-------------------------- rozhraní --------------------------------*/
	rollout rMain "Rozměry domu"
	(
		spinner spDelka "Délka (m):" type:#float range:[4,400,36] scale:0.25 fieldwidth:58
		slider  slDelka "" type:#float range:[4,400,36] ticks:0 width:150 offset:[0,-3]

		spinner spSirka "Hloubka (m):" type:#float range:[4,60,12] scale:0.25 fieldwidth:58
		slider  slSirka "" type:#float range:[4,60,12] ticks:0 width:150 offset:[0,-3]

		spinner spPodlazi "Počet podlaží:" type:#integer range:[1,40,8] fieldwidth:58
		slider  slPodlazi "" type:#integer range:[1,40,8] ticks:0 width:150 offset:[0,-3]

		spinner spVyskaP "Výška podlaží (m):" type:#float range:[2,8,2.8] scale:0.05 fieldwidth:58
		slider  slVyskaP "" type:#float range:[2,8,2.8] ticks:0 width:150 offset:[0,-3]

		spinner spTlSteny "Tloušťka stěn (m):" type:#float range:[0.08,1.5,0.3] scale:0.01 fieldwidth:58
		spinner spSokl "Výška soklu (m):" type:#float range:[0,4,0.6] scale:0.05 fieldwidth:58
		spinner spSoklP "Přesah soklu (m):" type:#float range:[0,0.5,0.06] scale:0.01 fieldwidth:58
		checkbox chkStropy "Vnitřní stropní desky" offset:[0,3]

		on slDelka changed val do pnl_setParam #delka val
		on slSirka changed val do pnl_setParam #sirka val
		on slPodlazi changed val do pnl_setParam #podlazi val
		on slVyskaP changed val do pnl_setParam #vyskaPodlazi val
		on rMain open do
			try
			(
				slDelka.value = delka
				slSirka.value = sirka
				slPodlazi.value = podlazi
				slVyskaP.value = vyskaPodlazi
			)
			catch ()
	)

	rollout rFasada "Fasáda a okna"
	(
		checkbox chkAutoOsy "Okenní osy dopočítat z délky" checked:true
		spinner spRozpon "Rozpon osy (m):" type:#float range:[1.5,12,3.6] scale:0.1 fieldwidth:58
		spinner spOsy "Počet os (ručně):" type:#integer range:[1,120,10] fieldwidth:58
		slider  slOsy "" type:#integer range:[1,120,10] ticks:0 width:150 offset:[0,-3]
		spinner spOknoS "Šířka okna (m):" type:#float range:[0.4,6,1.8] scale:0.05 fieldwidth:58
		spinner spOknoV "Výška okna (m):" type:#float range:[0.4,4,1.5] scale:0.05 fieldwidth:58
		spinner spParapet "Parapet (m):" type:#float range:[0,3,0.85] scale:0.05 fieldwidth:58
		checkbox chkRamy "Rámy oken" checked:true
		spinner spRam "Šířka rámu (m):" type:#float range:[0.02,0.3,0.07] scale:0.005 fieldwidth:58
		spinner spZapusteni "Zapuštění okna (m):" type:#float range:[0,0.6,0.14] scale:0.01 fieldwidth:58
		spinner spStitOkna "Oken ve štítu / patro:" type:#integer range:[0,8,0] fieldwidth:58

		on slOsy changed val do pnl_setParam #pocetOsi val
		on rFasada open do try (slOsy.value = pocetOsi) catch ()
	)

	rollout rDetaily "Detaily"
	(
		label lbO "— Okna a dveře —"
		spinner spDeleni "Křídel v okně:" type:#integer range:[1,4,2] fieldwidth:58
		checkbox chkNadsv "Nadsvětlík nad okny"
		checkbox chkParapet "Vnější parapetní plechy" checked:true
		spinner spKridla "Křídel vstupních dveří:" type:#integer range:[1,3,2] fieldwidth:58
		label lbO2 "Balkonové dveře = křídlo + pevné" offset:[0,2]
		label lbO3 "okno s parapetem." offset:[0,0]

		label lbP "— Panelová fasáda —" offset:[0,8]
		checkbox chkSpary "Spáry mezi panely" checked:true
		spinner spSpara "Šířka spáry (m):" type:#float range:[0.01,0.15,0.04] scale:0.005 fieldwidth:58

		label lbD "— Okolo domu —" offset:[0,8]
		checkbox chkOplech "Oplechování atiky" checked:true
		checkbox chkSklep "Sklepní okénka v soklu" checked:true
		checkbox chkSvody "Dešťové svody" checked:true
		checkbox chkStrDet "Komínky a anténa na střeše" checked:true
		checkbox chkVstupDet "Tablo zvonků, lampa, číslo" checked:true
		spinner spHran "Hran trubek (svody, zábradlí):" type:#integer range:[4,16,8] fieldwidth:44 offset:[0,4]
	)

	rollout rBalkony "Balkony"
	(
		dropdownlist ddlBalkony "" items:#("bez balkonů", "vpředu", "vzadu", "z obou stran") selection:2
		spinner spKrok "Balkon na každé N-té ose:" type:#integer range:[1,6,1] fieldwidth:44
		spinner spBalkonOd "Od podlaží č.:" type:#integer range:[1,40,2] fieldwidth:44
		spinner spBHl "Hloubka (m):" type:#float range:[0.4,4,1.5] scale:0.05 fieldwidth:58
		slider  slBHl "" type:#float range:[0.4,4,1.5] ticks:0 width:150 offset:[0,-3]
		spinner spBSir "Šířka (m):" type:#float range:[0.8,12,3.0] scale:0.05 fieldwidth:58
		slider  slBSir "" type:#float range:[0.8,12,3.0] ticks:0 width:150 offset:[0,-3]
		spinner spBDeska "Tloušťka desky (m):" type:#float range:[0.05,0.6,0.18] scale:0.01 fieldwidth:58
		dropdownlist ddlZabradli "Zábradlí:" items:#("plné", "svislé tyče", "plné + madlo") selection:1
		spinner spZabrV "Výška zábradlí (m):" type:#float range:[0.4,2,1.1] scale:0.05 fieldwidth:58
		spinner spZabrT "Tloušťka zábradlí (m):" type:#float range:[0.02,0.4,0.1] scale:0.01 fieldwidth:58
		spinner spTyce "Rozteč tyčí (m):" type:#float range:[0.05,0.6,0.14] scale:0.01 fieldwidth:58
		checkbox chkBalkDvere "Balkonové dveře místo okna" checked:true

		on slBHl changed val do pnl_setParam #balkonHloubka val
		on slBSir changed val do pnl_setParam #balkonSirka val
		on rBalkony open do
			try
			(
				slBHl.value = balkonHloubka
				slBSir.value = balkonSirka
			)
			catch ()
	)

	rollout rVariace "Variace a vzory"
	(
		spinner spSeed "Seed (číslo varianty):" type:#integer range:[0,999,1] fieldwidth:58
		slider  slSeed "" type:#integer range:[0,999,1] ticks:0 width:150 offset:[0,-3]
		button  btnLos "Losuj variantu" width:170 height:22 offset:[0,2]

		label lbB "— Rozmístění balkonů —" offset:[0,8]
		dropdownlist ddlBVzor "" width:160 selection:1 \
			items:#("na všech osách", "svislé pásy (nad sebou)", "šachovnice (zig-zag)", \
					"diagonála (posun po patrech)", "dvojice s mezerou", "náhodně")
		label lbB2 "Rozteč řídí \"na každé N-té ose\"" offset:[0,1]
		spinner spBHust "Hustota (pro náhodně):" type:#float range:[0.05,1,0.5] scale:0.05 fieldwidth:58
		checkbox chkStridat "Střídat přední/zadní stranu"

		label lbC "— Barvy zábradlí —" offset:[0,8]
		dropdownlist ddlBarvy "" width:160 selection:1 \
			items:#("jedna barva", "po sloupcích", "po patrech", "šikmé pruhy", "náhodně")
		spinner spPocetBarev "Počet barev:" type:#integer range:[2,4,3] fieldwidth:58

		label lbF "— Barevné panely fasády —" offset:[0,8]
		dropdownlist ddlFVzor "" width:160 selection:1 \
			items:#("bez akcentů", "náhodné panely", "svislé pruhy", "vodorovné pásy")
		spinner spFHust "Podíl akcentů:" type:#float range:[0.05,1,0.25] scale:0.05 fieldwidth:58

		label lbS "— Rozsvícená okna —" offset:[0,8]
		spinner spSviti "Podíl svítících oken:" type:#float range:[0,1,0.0] scale:0.05 fieldwidth:58
		label lbS2 "0 = všechna zhasnutá" offset:[0,1]

		on slSeed changed val do pnl_setParam #seed val
		on btnLos pressed do panelakLosuj()
		on rVariace open do try (slSeed.value = seed) catch ()
	)

	rollout rVstupy "Vstupy"
	(
		spinner spVchody "Počet vchodů:" type:#integer range:[0,20,2] fieldwidth:58
		slider  slVchody "" type:#integer range:[0,20,2] ticks:0 width:150 offset:[0,-3]
		checkbox chkVchodyVzadu "Vstupy i ze zadní strany"
		spinner spDverS "Šířka dveří (m):" type:#float range:[0.8,6,1.8] scale:0.05 fieldwidth:58
		spinner spDverV "Výška dveří (m):" type:#float range:[1.8,4,2.3] scale:0.05 fieldwidth:58
		checkbox chkStriska "Stříška nad vstupem" checked:true
		spinner spStriskaS "Šířka stříšky (m):" type:#float range:[0.8,8,3.0] scale:0.1 fieldwidth:58
		spinner spStriskaH "Vyložení stříšky (m):" type:#float range:[0.2,4,1.4] scale:0.05 fieldwidth:58
		spinner spStriskaT "Tloušťka stříšky (m):" type:#float range:[0.05,0.5,0.18] scale:0.01 fieldwidth:58
		checkbox chkSchody "Schody před vstupem" checked:true
		spinner spSchodyS "Šířka schodů (m):" type:#float range:[0.8,8,2.4] scale:0.1 fieldwidth:58
		spinner spSchodyH "Hloubka stupně (m):" type:#float range:[0.2,0.6,0.32] scale:0.01 fieldwidth:58

		on slVchody changed val do pnl_setParam #vchody val
		on rVstupy open do try (slVchody.value = vchody) catch ()
	)

	rollout rStrecha "Střecha"
	(
		spinner spStrechaT "Tloušťka střechy (m):" type:#float range:[0.05,1,0.3] scale:0.05 fieldwidth:58
		spinner spAtikaV "Výška atiky (m):" type:#float range:[0,2,0.6] scale:0.05 fieldwidth:58
		spinner spAtikaT "Tloušťka atiky (m):" type:#float range:[0.05,1,0.25] scale:0.01 fieldwidth:58
		checkbox chkStrojovna "Strojovna nad vchody" checked:true
		spinner spStrojV "Výška strojovny (m):" type:#float range:[1,6,2.6] scale:0.1 fieldwidth:58
	)

	rollout rMat "Materiál a mapování"
	(
		checkbox chkMapovani "Generovat UV mapování" checked:true
		spinner spUV "Velikost dlaždice UV (m):" type:#float range:[0.05,20,1.0] scale:0.1 fieldwidth:58
		spinner spJednotky "1 m = ... jednotek:" type:#float range:[0.0001,10000,1.0] scale:1 fieldwidth:58
		button btnMat "Vytvořit a přiřadit materiál" width:170 height:22 offset:[0,4]
		button btnPoly "Vytvořit Editable Poly (kopii)" width:170 height:22 offset:[0,3]
		label lblInfo1 "Originál zůstane parametrický," offset:[0,4]
		label lblInfo2 "upravuj až tu kopii."

		on btnMat pressed do panelakMaterial()
		on btnPoly pressed do panelakToPoly()
	)

	/*-------------------------- geometrie -------------------------------*/
	on buildMesh do
	(
		local cx = pnl_ctx()
		cx.V = #(); cx.F = #(); cx.M = #(); cx.TV = #(); cx.TF = #(); cx.S = #()
		local U  = amax 0.0001 unitsPerM
		local uv = if mapovani then (amax 0.001 (uvMeritko * U)) else 0.0

		local L  = amax (2.0 * U) (delka * U)
		local W  = amax (2.0 * U) (sirka * U)
		local NF = amax 1 podlazi
		local fh = amax (1.5 * U) (vyskaPodlazi * U)
		local t  = amin (amax (0.05 * U) (tlSteny * U)) (amin (L * 0.2) (W * 0.2))
		local zb = amax 0.0 (soklVyska * U)
		local so = amax 0.0 (soklPresah * U)
		local mrg = 0.25 * U

		local x0 = -L * 0.5, x1 = L * 0.5
		local y0 = -W * 0.5, y1 = W * 0.5
		local zTop = zb + NF * fh

		-- okenní osy
		local n = amax 1 pocetOsi
		if autoOsy do n = amax 1 ((floor (L / (amax (1.0 * U) (rozponOsy * U)) + 0.5)) as integer)
		local stepX = L / n
		local AX = for i = 1 to n collect (x0 + stepX * (i - 0.5))

		local oh = amin (amax (0.3 * U) (oknoVyska * U)) (fh - 0.4 * U)
		local ow = amin (amax (0.3 * U) (oknoSirka * U)) (stepX - 0.4 * U)
		local par = amax (0.0) (amin (parapet * U) (fh - oh - 0.25 * U))
		local hasWin = ow > 0.25 * U

		-- vchody
		local ne = amax 0 vchody
		local dw = if ne > 0 then (amin (dverSirka * U) (L / ne - 0.8 * U)) else 0.0
		local dh = amin (dverVyska * U) (fh - 0.25 * U)
		if dw < 0.6 * U do ( ne = 0; dw = 0.0 )
		local EX = for e = 1 to ne collect (x0 + L * (e - 0.5) / ne)

		-- balkony: jedna mapa řídí balkony i balkonové dveře, takže spolu sedí
		local bmap = pnl_balcMap n NF balkonVzor (amax 1 balkonKrok) (amax 1 balkonOd) \
			balkonHustota balkony stridatStrany seed
		local bw = amin (amax (0.6 * U) (balkonSirka * U)) (stepX - 0.1 * U)
		local bd = amax (0.3 * U) (balkonHloubka * U)
		local bs = amax (0.03 * U) (balkonDeska * U)
		local rh = amax (0.3 * U) (zabradliVyska * U)
		local rt = amin (amax (0.02 * U) (zabradliTl * U)) (bd * 0.4)

		local fw = amax (0.01 * U) (ramSirka * U)
		local ins = amin (amax 0.0 (sklozap * U)) (t - fw * 1.2)
		if ins < 0.0 do ins = 0.0

		-- nastavení detailů výplní (rozměry už v jednotkách scény)
		local det = pnl_det()
		det.U = U
		det.ramy = ramy
		det.ram = fw
		det.zapusteni = ins
		det.deleni = amax 1 oknoDeleni
		det.nadsvetlik = oknaNadsvetlik
		det.nadsvetlikV = 0.45 * U
		det.parapetPlech = parapetPlech
		det.parapetTl = 0.04 * U
		det.parapetPresah = 0.07 * U
		det.balkonParapet = amax (0.2 * U) par
		det.dverKridla = amax 1 dverKridla
		det.dverNadsvetlik = true
		det.dverNadsvetlikV = 0.5 * U

		/*--- otvory ve fasádách ---*/
		local exF = EX
		local exB = if vchodyVzadu then EX else #()
		local neB = if vchodyVzadu then ne else 0

		local resF = pnl_facadeOps2 AX (if hasWin then n else 0) ow oh par zb fh NF \
			bmap 1 balkonoveDvere exF ne dw dh mrg
		local resB = pnl_facadeOps2 AX (if hasWin then n else 0) ow oh par zb fh NF \
			bmap 2 balkonoveDvere exB neB dw dh mrg
		local opsF = resF[1], kndF = resF[2]
		local opsB = resB[1], kndB = resB[2]

		/*--- sokl se sklepními okénky ---*/
		if zb > 0.02 * U then
		(
			-- sokl se staví jako stěny s otvory, ne jako plný kvádr, aby šla
			-- do sklepních okének vidět tma
			local sops = #()
			if sklepniOkna do
				for i = 1 to n do
				(
					local sow = amin (0.9 * U) (stepX * 0.4)
					local soh = amin (0.5 * U) (zb * 0.42)
					local soz = zb - soh - 0.12 * U
					if soz > 0.12 * U do
						append sops [ AX[i] - sow * 0.5, AX[i] + sow * 0.5, soz, soz + soh ]
				)
			local SR = pnl_wallRects (x0 - so) (x1 + so) 0 zb sops
			for r in SR do
			(
				pnl_addBox cx r.x (y0 - so) r.z r.y (y0 + t) r.w PNL_MAT_SOKL uv
				pnl_addBox cx r.x (y1 - t) r.z r.y (y1 + so) r.w PNL_MAT_SOKL uv
			)
			pnl_addBox cx (x0 - so) (y0 + t) 0 (x0 + t) (y1 - t) zb PNL_MAT_SOKL uv
			pnl_addBox cx (x1 - t) (y0 + t) 0 (x1 + so) (y1 - t) zb PNL_MAT_SOKL uv
			pnl_addBox cx (x0 - so) (y0 - so) 0 (x1 + so) (y1 + so) (0.15 * U) PNL_MAT_SOKL uv
			pnl_addBox cx (x0 - so) (y0 - so) (zb - 0.2 * U) (x1 + so) (y1 + so) zb PNL_MAT_SOKL uv
			for op in sops do
			(
				pnl_addBox cx op.x (y0 - so + 0.05 * U) op.z op.y (y0 - so + 0.09 * U) op.w PNL_MAT_SKLO uv
				pnl_addBox cx op.x (y1 + so - 0.09 * U) op.z op.y (y1 + so - 0.05 * U) op.w PNL_MAT_SKLO uv
			)
		)
		else
			pnl_addBox cx x0 y0 (-0.25 * U) x1 y1 0 PNL_MAT_SOKL uv

		/*--- obvodové stěny ---*/
		local R = pnl_wallRects x0 x1 zb zTop opsF
		for r in R do
			pnl_addBox cx r.x y0 r.z r.y (y0 + t) r.w \
				(pnl_fasadaMat ((r.x + r.y) * 0.5) ((r.z + r.w) * 0.5) fasadaVzor fasadaHustota stepX fh seed) uv

		R = pnl_wallRects x0 x1 zb zTop opsB
		for r in R do
			pnl_addBox cx r.x (y1 - t) r.z r.y y1 r.w \
				(pnl_fasadaMat ((r.x + r.y) * 0.5) ((r.z + r.w) * 0.5) fasadaVzor fasadaHustota stepX fh (seed + 5)) uv

		-- štítové stěny
		local opsG = #()
		if stitOkna > 0 do
		(
			local sy = (W - 2 * t) / stitOkna
			local gw = amin (oknoSirka * U) (sy - 0.4 * U)
			if gw > 0.25 * U do
				for f = 1 to NF do
				(
					local zf = zb + (f - 1) * fh
					for k = 1 to stitOkna do
					(
						local yc = y0 + t + sy * (k - 0.5)
						append opsG [ yc - gw * 0.5, yc + gw * 0.5, zf + par, zf + par + oh ]
					)
				)
		)
		R = pnl_wallRects (y0 + t) (y1 - t) zb zTop opsG
		for r in R do
		(
			pnl_addBox cx x0 r.x r.z (x0 + t) r.y r.w PNL_MAT_FASADA uv
			pnl_addBox cx (x1 - t) r.x r.z x1 r.y r.w PNL_MAT_FASADA uv
		)

		/*--- výplně otvorů ---*/
		for j = 1 to opsF.count do
			pnl_fillOpening cx opsF[j] kndF[j] true y0 1.0 det (pnl_skloMat opsF[j] oknaSviti seed) uv
		for j = 1 to opsB.count do
			pnl_fillOpening cx opsB[j] kndB[j] true y1 (-1.0) det (pnl_skloMat opsB[j] oknaSviti (seed + 5)) uv
		for o in opsG do
		(
			pnl_fillOpening cx o 1 false x0 1.0 det (pnl_skloMat o oknaSviti (seed + 9)) uv
			pnl_fillOpening cx o 1 false x1 (-1.0) det (pnl_skloMat o oknaSviti (seed + 13)) uv
		)

		/*--- spáry mezi panely ---*/
		if spary do
		(
			local ss = amax (0.01 * U) (sparaSirka * U)
			local sv = 0.025 * U
			local modY = amax (1.5 * U) (rozponOsy * U)
			pnl_spary cx true x0 x1 y0 1.0 zb zTop stepX fh ss sv uv
			pnl_spary cx true x0 x1 y1 (-1.0) zb zTop stepX fh ss sv uv
			pnl_spary cx false (y0 + t) (y1 - t) x0 1.0 zb zTop modY fh ss sv uv
			pnl_spary cx false (y0 + t) (y1 - t) x1 (-1.0) zb zTop modY fh ss sv uv
		)

		/*--- vnitřní stropy ---*/
		if vnitrniStropy do
			for f = 2 to NF do
			(
				local zf = zb + (f - 1) * fh
				pnl_addBox cx (x0 + t) (y0 + t) (zf - 0.22 * U) (x1 - t) (y1 - t) zf PNL_MAT_DESKA uv
			)

		/*--- balkony ---*/
		for f = 1 to NF do
		(
			local zf = zb + (f - 1) * fh
			for i = 1 to n do
			(
				local bv = bmap[f][i]
				if bv > 0 do
				(
					local mrail = pnl_balcMat f i zabradliBarvy pocetBarev seed
					if bv == 1 or bv == 3 do
						pnl_balkon cx AX[i] y0 (-1.0) zf bw bd bs rh rt zabradliTyp (tyceKrok * U) mrail uv
					if bv == 2 or bv == 3 do
						pnl_balkon cx AX[i] y1 1.0 zf bw bd bs rh rt zabradliTyp (tyceKrok * U) mrail uv
				)
			)
		)

		/*--- vstupy: dveře, stříšky, schody ---*/
		for pass = 1 to 2 do
		(
			local cnt = if pass == 1 then ne else neB
			local yw  = if pass == 1 then y0 else y1
			local dir = if pass == 1 then -1.0 else 1.0
			for e = 1 to cnt do
			(
				local xe = EX[e]
				if strisky do
				(
					local cw = amax (dw + 0.4 * U) (striskaSirka * U)
					local cd = amax (0.2 * U) (striskaHloubka * U)
					local ct = amax (0.04 * U) (striskaTl * U)
					local zc = zb + dh + 0.12 * U
					pnl_addBox cx (xe - cw * 0.5) (yw + dir * cd) zc \
						(xe + cw * 0.5) (yw - dir * t * 0.5) (zc + ct) PNL_MAT_STRECHA uv
				)
				if schody and zb > 0.05 * U do
				(
					local ns = amax 1 ((ceil (zb / (0.17 * U))) as integer)
					local hs = zb / ns
					local ds = amax (0.15 * U) (schodyHloubka * U)
					local sw = amax (dw + 0.4 * U) (schodySirka * U)
					for k = 1 to ns do
						pnl_addBox cx (xe - sw * 0.5) (yw + dir * (ns - k + 1) * ds) 0 \
							(xe + sw * 0.5) yw (k * hs) PNL_MAT_SOKL uv
					/*	Trubkové zábradlí kopírující sklon schodů:
						madlo jde šikmo od spodního sloupku k hornímu, souběžně
						s hranami stupňů, a pod ním vede druhá trubka.        */
					local rr = 0.025 * U
					local hr = amax 4 trubkaHran
					local rvys = 0.95 * U              -- výška madla nad stupněm
					local yRa = yw + dir * ns * ds     -- u nejnižšího stupně
					local zRa = hs + rvys
					local yRb = yw + dir * ds * 0.5    -- u horního stupně (podesty)
					local zRb = zb + rvys
					local hw = sw * 0.5
					for sgn in #(-1.0, 1.0) do
					(
						local hx = xe + sgn * (hw - rr)
						-- sloupky (dolů až na terén, spodek schová schodiště)
						pnl_addPipe2 cx [hx, yRa, 0] [hx, yRa, zRa] rr hr PNL_MAT_ZABRADLI uv
						pnl_addPipe2 cx [hx, yRb, 0] [hx, yRb, zRb] rr hr PNL_MAT_ZABRADLI uv
						-- šikmé madlo a spodní trubka
						pnl_addPipe2 cx [hx, yRa, zRa] [hx, yRb, zRb] rr hr PNL_MAT_ZABRADLI uv
						pnl_addPipe2 cx [hx, yRa, zRa - 0.4 * U] [hx, yRb, zRb - 0.4 * U] rr hr PNL_MAT_ZABRADLI uv
					)
				)
				if vstupDetail do
				(
					-- tablo zvonků vedle dveří
					pnl_addBox cx (xe + dw * 0.5 + 0.25 * U) (yw - dir * 0.05 * U) (zb + 1.15 * U) \
						(xe + dw * 0.5 + 0.47 * U) (yw + dir * 0.02 * U) (zb + 1.5 * U) PNL_MAT_DROBNOSTI uv
					-- lampa nad dveřmi
					pnl_addBox cx (xe - 0.15 * U) (yw - dir * 0.24 * U) (zb + dh + 0.3 * U) \
						(xe + 0.15 * U) (yw + dir * 0.02 * U) (zb + dh + 0.46 * U) PNL_MAT_DROBNOSTI uv
					-- číslo popisné
					pnl_addBox cx (xe - dw * 0.5 - 0.55 * U) (yw - dir * 0.04 * U) (zb + dh + 0.45 * U) \
						(xe - dw * 0.5 - 0.1 * U) (yw + dir * 0.02 * U) (zb + dh + 0.78 * U) PNL_MAT_DROBNOSTI uv
				)
			)
		)

		/*--- střecha ---*/
		local rtk = amax (0.04 * U) (strechaTl * U)
		pnl_addBox cx x0 y0 zTop x1 y1 (zTop + rtk) PNL_MAT_STRECHA uv
		local ah = amax 0.0 (atikaVyska * U)
		if ah > 0.02 * U do
		(
			local atk = amin (amax (0.04 * U) (atikaTl * U)) (amin (L * 0.2) (W * 0.2))
			local za = zTop + rtk
			local zc = za + ah
			pnl_addBox cx x0 y0 za x1 (y0 + atk) zc PNL_MAT_STRECHA uv
			pnl_addBox cx x0 (y1 - atk) za x1 y1 zc PNL_MAT_STRECHA uv
			pnl_addBox cx x0 (y0 + atk) za (x0 + atk) (y1 - atk) zc PNL_MAT_STRECHA uv
			pnl_addBox cx (x1 - atk) (y0 + atk) za x1 (y1 - atk) zc PNL_MAT_STRECHA uv
			-- oplechování atiky: přesahuje přes obě hrany
			if oplechovani do
			(
				local ov = 0.07 * U
				local ot = 0.05 * U
				pnl_addBox cx (x0 - ov) (y0 - ov) zc (x1 + ov) (y0 + atk + ov) (zc + ot) PNL_MAT_KLEMP uv
				pnl_addBox cx (x0 - ov) (y1 - atk - ov) zc (x1 + ov) (y1 + ov) (zc + ot) PNL_MAT_KLEMP uv
				pnl_addBox cx (x0 - ov) (y0 + atk) zc (x0 + atk + ov) (y1 - atk) (zc + ot) PNL_MAT_KLEMP uv
				pnl_addBox cx (x1 - atk - ov) (y0 + atk) zc (x1 + ov) (y1 - atk) (zc + ot) PNL_MAT_KLEMP uv
			)
		)

		/*--- dešťové svody v rozích (skutečné trubky) ---*/
		if svody do
		(
			local pr = 0.07 * U
			local zt2 = zTop + rtk + ah
			local hr = amax 4 trubkaHran
			-- svody patří na štítové stěny, na podélných fasádách by lezly do balkonů
			local PX = #(x0 - pr * 1.25, x1 + pr * 1.25)
			local PY = #(y0 + 0.7 * U, y1 - 0.7 * U)
			for sx in PX do
				for sy in PY do
				(
					pnl_addPipe cx 3 0 zt2 sx sy pr hr PNL_MAT_KLEMP uv
					-- rozšířený kus u země
					pnl_addPipe cx 3 0 (0.5 * U) sx sy (pr * 1.35) hr PNL_MAT_KLEMP uv
					-- objímky ke stěně
					pnl_addPipe cx 3 (zt2 * 0.35 - 0.04 * U) (zt2 * 0.35 + 0.04 * U) sx sy (pr * 1.5) hr PNL_MAT_KLEMP uv
					pnl_addPipe cx 3 (zt2 * 0.7 - 0.04 * U) (zt2 * 0.7 + 0.04 * U) sx sy (pr * 1.5) hr PNL_MAT_KLEMP uv
				)
		)

		/*--- komínky a anténa na střeše ---*/
		if strechaDetail do
		(
			local zr2 = zTop + rtk
			local nv = amax 2 ((floor (L / (7.0 * U))) as integer)
			for k = 1 to nv do
			(
				local vx = x0 + L * (k - 0.5) / nv
				local vy = ((pnl_hash (k * 4.1) 1.0 seed) - 0.5) * (W - 3.0 * U)
				local vd = 0.3 * U
				local vh = (0.5 + (pnl_hash (k * 2.7) 2.0 seed)) * 0.7 * U
				pnl_addBox cx (vx - vd * 0.5) (vy - vd * 0.5) zr2 (vx + vd * 0.5) (vy + vd * 0.5) (zr2 + vh) PNL_MAT_KLEMP uv
				pnl_addBox cx (vx - vd * 0.85) (vy - vd * 0.85) (zr2 + vh) \
					(vx + vd * 0.85) (vy + vd * 0.85) (zr2 + vh + 0.08 * U) PNL_MAT_KLEMP uv
			)
			-- anténní stožár
			local amx = x0 + L * 0.35
			pnl_addBox cx (amx - 0.05 * U) (-0.05 * U) zr2 (amx + 0.05 * U) (0.05 * U) (zr2 + 3.5 * U) PNL_MAT_KLEMP uv
			pnl_addBox cx (amx - 0.5 * U) (-0.04 * U) (zr2 + 2.6 * U) (amx + 0.5 * U) (0.04 * U) (zr2 + 2.68 * U) PNL_MAT_KLEMP uv
			pnl_addBox cx (amx - 0.4 * U) (-0.04 * U) (zr2 + 3.0 * U) (amx + 0.4 * U) (0.04 * U) (zr2 + 3.08 * U) PNL_MAT_KLEMP uv
		)

		/*--- strojovny / výlezy na střeše ---*/
		if strojovna and ne > 0 do
			for e = 1 to ne do
			(
				local sw = amin (3.6 * U) (L / ne - 1.0 * U)
				local sd = amin (3.2 * U) (W - 2.0 * U)
				local sh = amax (0.5 * U) (strojovnaVyska * U)
				local za = zTop + rtk
				if sw > 0.5 * U and sd > 0.5 * U do
				(
					pnl_addBox cx (EX[e] - sw * 0.5) (-sd * 0.5) za \
						(EX[e] + sw * 0.5) (sd * 0.5) (za + sh) PNL_MAT_FASADA uv
					pnl_addBox cx (EX[e] - sw * 0.5 - 0.15 * U) (-sd * 0.5 - 0.15 * U) (za + sh) \
						(EX[e] + sw * 0.5 + 0.15 * U) (sd * 0.5 + 0.15 * U) (za + sh + 0.18 * U) \
						PNL_MAT_STRECHA uv
				)
			)

		/*--- sestavení meshe ---*/
		if cx.V.count < 3 do
			pnl_addBox cx x0 y0 0 x1 y1 (1.0 * U) PNL_MAT_FASADA uv

		local vc = cx.V.count
		local fc = cx.F.count
		setMesh mesh numVerts:vc numFaces:fc
		for i = 1 to vc do setVert mesh i cx.V[i]
		for i = 1 to fc do
		(
			setFace mesh i cx.F[i]
			setFaceMatID mesh i cx.M[i]
			setFaceSmoothGroup mesh i (if i <= cx.S.count then cx.S[i] else 0)
			-- Viditelnost hran. setMesh je vynuluje (= všechny hrany neviditelné)
			-- a převod na Editable Poly pak nemá z čeho polygony složit.
			-- Faces chodí v párech (každý obdélník = 2 trojúhelníky), u každého
			-- schováme jen společnou úhlopříčku -> po převodu vzniknou čtyřúhelníky.
			if (mod i 2) > 0.5 then
			(
				setEdgeVis mesh i 1 true
				setEdgeVis mesh i 2 true
				setEdgeVis mesh i 3 false
			)
			else
			(
				setEdgeVis mesh i 1 false
				setEdgeVis mesh i 2 true
				setEdgeVis mesh i 3 true
			)
		)
		if uv > 0 and cx.TF.count == fc do
		(
			-- pořadí je důležité: nejdřív texturové vertexy, teprve pak tvfaces
			setNumTVerts mesh cx.TV.count
			buildTVFaces mesh
			if (getNumTVerts mesh) != cx.TV.count do setNumTVerts mesh cx.TV.count
			for i = 1 to cx.TV.count do setTVert mesh i cx.TV[i]
			for i = 1 to fc do setTVFace mesh i cx.TF[i]
		)
		update mesh
	)
)

/*--- nastavení parametru u vybraných paneláků --------------------------------
	Slidery v rolloutech volají tuhle funkci, aby se hodnota zapsala přímo do
	objektu (nespoléhá se na dosah jmen parametrů v obsluze rolloutu).        */
fn pnl_setParam pname val =
(
	for o in (selection as array) where (isKindOf o PanelakGeo) do setProperty o pname val
	ok
)

/*--- převod na Editable Poly -------------------------------------------------
	Nepoužívá se příkaz Convert to Editable Poly z pravého tlačítka (ten u
	scripted pluginů někdy vyrobí prázdný objekt), ale snapshotAsMesh, tedy
	přesně ta síť, která je vidět v pohledu. Originál zůstane parametrický.  */
fn panelakToPoly nodes:unsupplied =
(
	local trg = if nodes == unsupplied then (selection as array) else nodes
	local res = #()
	for o in trg where (superclassof o) == GeometryClass do
	(
		local tm = undefined
		local baked = false          -- true = síť je už ve world space
		try
		(
			local m1 = copy o.mesh
			format "Panelák \"%\": o.mesh = % vertů, % faců\n" o.name m1.numverts m1.numfaces
			if m1.numfaces > 0 do tm = m1
		)
		catch (format "Panelák \"%\": o.mesh nedostupný\n" o.name)
		if tm == undefined do
			try
			(
				local m2 = snapshotAsMesh o
				format "  snapshotAsMesh = % vertů, % faců\n" m2.numverts m2.numfaces
				if m2.numfaces > 0 do ( tm = m2; baked = true )
			)
			catch (format "  snapshotAsMesh selhal\n")
		if tm == undefined then
			format "  žádná cesta nevrátila faces - nemám co převést\n"
		else
		(
			local n = mesh mesh:tm name:(uniquename (o.name + "_poly"))
			if not baked do n.transform = o.transform
			n.material = o.material
			n.wirecolor = o.wirecolor
			try (convertToPoly n) catch (format "  převod na poly se nepovedl, zůstal Editable Mesh\n")
			try (format "  hotovo: % polygonů\n" (polyop.getNumFaces n)) catch ()
			append res n
		)
	)
	if res.count > 0 do select res
	res
)

/*--- vylosování náhodné varianty --------------------------------------------
	Mění jen vzory a seed, rozměry domu nechává být.                        */
fn panelakLosuj nodes:unsupplied =
(
	local trg = if nodes == unsupplied then (selection as array) else nodes
	local cnt = 0
	for o in trg where (isProperty o #seed) do
	(
		o.seed = random 0 999
		o.balkonVzor = random 1 6
		o.balkonKrok = random 1 3
		o.zabradliBarvy = random 1 5
		o.pocetBarev = random 2 4
		o.fasadaVzor = random 1 4
		o.stridatStrany = ((random 0 1) == 1)
		cnt = cnt + 1
	)
	if cnt == 0 then
		format "Losování: není vybraný žádný panelák.\n"
	else
		format "Vylosováno pro % objektů.\n" cnt
	ok
)

/*--------------------------- materiál ---------------------------------------*/
/*--- bezpečné nastavení vlastnosti ------------------------------------------
	Názvy parametrů VRayMtl se mezi verzemi liší, tak ať neznámá vlastnost
	neshodí celý materiál.                                                  */
fn pnl_setProp m pname val =
(
	try ( setProperty m pname val ) catch ()
	ok
)

/*--- sklo -------------------------------------------------------------------
	Přednostně VRayMtl. Odraz je řízený Fresnelem (kolmo skoro nic, při ostrém
	úhlu se zrcadlí), lom má IOR 1.0, takže obraz neláme a je vidět dovnitř.
	Tmavý diffuse dělá to, že interiér působí jako tma za sklem.            */
fn pnl_mkGlass nm tint =
(
	local m = undefined
	try ( m = VRayMtl name:nm ) catch ( m = undefined )
	if m != undefined then
	(
		pnl_setProp m #Diffuse (color 8 10 12)
		pnl_setProp m #reflection (color 240 244 248)
		pnl_setProp m #reflection_fresnel true
		pnl_setProp m #reflection_lockIOR false
		pnl_setProp m #reflection_ior 1.52
		pnl_setProp m #reflection_glossiness 1.0
		pnl_setProp m #reflection_subdivs 12
		pnl_setProp m #refraction (color 52 58 64)
		pnl_setProp m #refraction_ior 1.0
		pnl_setProp m #refraction_glossiness 1.0
		pnl_setProp m #refraction_affectShadows true
		pnl_setProp m #refraction_fogColor tint
		pnl_setProp m #refraction_fogMult 0.35
		pnl_setProp m #option_cutOff 0.005
	)
	else
	(
		try ( m = PhysicalMaterial name:nm ) catch ( m = undefined )
		if m != undefined then
		(
			pnl_setProp m #base_color (color 10 12 14)
			pnl_setProp m #roughness 0.0
			pnl_setProp m #transparency 0.8
			pnl_setProp m #trans_ior 1.52
			pnl_setProp m #reflectivity 0.6
		)
		else
		(
			m = standardMaterial name:nm diffuse:(color 18 22 26)
			m.opacity = 28
			m.specularLevel = 95
			m.glossiness = 85
		)
	)
	m
)

fn pnl_mkMat nm col rough emit:false =
(
	local m = undefined
	try ( m = PhysicalMaterial name:nm base_color:col roughness:rough ) catch ( m = undefined )
	if m != undefined then
	(
		if emit do try ( m.emission = 1.0; m.emit_color = col ) catch ()
	)
	else
	(
		m = standardMaterial name:nm diffuse:col
		m.specularLevel = (100 - rough * 100) * 0.6
		m.glossiness = 100 - rough * 100
		if emit do try ( m.selfIllumAmount = 100 ) catch ()
	)
	m
)

/*--- svítící okno: VRayLightMtl, jinak samosvítící materiál -----------------*/
fn pnl_mkLight nm col =
(
	local m = undefined
	try ( m = VRayLightMtl name:nm ) catch ( m = undefined )
	if m != undefined then
	(
		pnl_setProp m #color col
		pnl_setProp m #multiplier 3.0
		pnl_setProp m #compensate_exposure true
		pnl_setProp m #emitOnBackSide false
	)
	else
		m = pnl_mkMat nm col 0.1 emit:true
	m
)

fn panelakMaterial nodes:unsupplied =
(
	local trg = if nodes == unsupplied then (selection as array) else nodes
	if trg.count == 0 do trg = for o in objects where (classof o) == PanelakGeo collect o
	local defs = #( \
		#("Fasáda",           (color 226 220 206), 0.75), \
		#("Sokl",             (color 92 94 96),    0.85), \
		#("Sklo",             (color 186 206 210), 0.05, "sklo"), \
		#("Rámy oken",        (color 245 245 242), 0.45), \
		#("Zábradlí 1",       (color 176 186 196), 0.40), \
		#("Balkonové desky",  (color 178 174 166), 0.80), \
		#("Střecha/atika",    (color 120 120 118), 0.90), \
		#("Vstupní dveře",    (color 46 62 74),    0.25), \
		#("Nosné stěny",      (color 208 202 192), 0.85), \
		#("Příčky",           (color 236 233 226), 0.85), \
		#("Podlahy",          (color 166 142 116), 0.70), \
		#("Schodiště",        (color 150 150 148), 0.85), \
		#("Vnitřní dveře",    (color 176 142 104), 0.50), \
		#("Zábradlí 2",       (color 214 126 52),  0.40), \
		#("Zábradlí 3",       (color 74 122 168),  0.40), \
		#("Zábradlí 4",       (color 132 160 104), 0.40), \
		#("Fasáda akcent 1",  (color 222 176 96),  0.75), \
		#("Fasáda akcent 2",  (color 120 152 176), 0.75), \
		#("Okno svítí teple", (color 255 214 140), 0.10, "svit"), \
		#("Okno svítí bíle",  (color 226 236 255), 0.10, "svit"), \
		#("Spáry panelů",     (color 150 146 138), 0.90), \
		#("Klempířina",       (color 190 192 194), 0.35), \
		#("Drobnosti",        (color 96 98 100),   0.45), \
		#("Krytina",          (color 138 68 52),   0.80), \
		#("Římsy a šambrány", (color 242 238 228), 0.70) )
	local mm = multimaterial numsubs:defs.count
	mm.name = "Panelák"
	for i = 1 to defs.count do
	(
		local knd = if defs[i].count > 3 then defs[i][4] else ""
		local msub = undefined
		if knd == "sklo" then msub = pnl_mkGlass defs[i][1] defs[i][2]
		else if knd == "svit" then msub = pnl_mkLight defs[i][1] defs[i][2]
		else msub = pnl_mkMat defs[i][1] defs[i][2] defs[i][3]
		mm[i] = msub
		mm.names[i] = defs[i][1]
	)
	try ( format "Panelák: materiál hotov, sklo = %\n" ((classof mm[3]) as string) ) catch ()
	for o in trg where (superclassof o) == GeometryClass do o.material = mm
	mm
)

/*--------------------------- tlačítko do toolbaru ---------------------------*/
macroScript PanelakCreate
	category:"Panelak"
	buttonText:"Panelak"
	tooltip:"Vytvorit parametricky panelak"
(
	on execute do
	(
		local pnode = PanelakGeo name:(uniquename "Panelak")
		select pnode
		max modify mode
	)
)

format "\nPanelák: plugin načten. Create > Geometry > kategorie \"Panelák\", nebo napiš: PanelakGeo()\n"
