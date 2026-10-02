/*------------------------------------------------------------------------------
	BUDOVY - sdílená knihovna pro generátory domů
	--------------------------------------------
	Staví na primitivech z panelak.ms (kvádr, trubka, stěna s otvory, výplně
	otvorů, materiál) a přidává to, co panelák nepotřeboval: šikmé plochy,
	hranoly a z nich střechy.

	Tenhle soubor se nespouští sám o sobě - natahují si ho generátory:
		dum-rodinny.ms, dum-mestsky.ms, dum-vyskovy.ms, dum-moderni.ms
------------------------------------------------------------------------------*/

/*	panelak.ms se načítá vždycky, ať se verze funkcí nerozejdou. */
(
	local bud_dir = ""
	try ( bud_dir = getFilenamePath (getSourceFileName()) ) catch ( bud_dir = "" )
	local bud_base = bud_dir + "panelak.ms"
	if bud_dir != "" and (doesFileExist bud_base) then
		fileIn bud_base
	else
	(
		if (isKindOf pnl_addBox MAXScriptFunction) != true do
			format "CHYBA: vedle budovy-lib.ms musí ležet panelak.ms\n"
	)
)

-- ID materiálů navíc proti paneláku
global BUD_MAT_KRYTINA = 24
global BUD_MAT_RIMSA   = 25

/*--- rovinná plocha ---------------------------------------------------------
	pts = pole bodů v pořadí proti směru hodinových ručiček při pohledu
	zvenku (odtud koukají normály). Dělí se vějířem od prvního bodu.
	UV se promítne rovinně podle převládající osy normály.                  */
fn bud_face cx pts mid uvs =
(
	local np = pts.count
	if np >= 3 do
	(
		local o = cx.V.count
		for p in pts do append cx.V p
		local nrm = [0, 0, 1]
		try ( nrm = normalize (cross (pts[2] - pts[1]) (pts[3] - pts[1])) ) catch ()
		local qx = abs nrm.x
		local qy = abs nrm.y
		local qz = abs nrm.z
		local ia = 1
		local ib = 2
		if qz >= qx and qz >= qy then ( ia = 1; ib = 2 )
		else if qx >= qy then ( ia = 2; ib = 3 )
		else ( ia = 1; ib = 3 )
		local tb = cx.TV.count
		if uvs > 0 do
			for p in pts do append cx.TV [ p[ia] / uvs, p[ib] / uvs, 0 ]
		for k = 2 to np - 1 do
		(
			append cx.F [ o + 1, o + k, o + k + 1 ]
			append cx.M mid
			append cx.S 0
			if uvs > 0 do append cx.TF [ tb + 1, tb + k, tb + k + 1 ]
		)
	)
	ok
)

/*--- hranol mezi dvěma stejně velkými obrysy --------------------------------
	A i B mají stejný počet bodů. A je čelo blíž k počátku dané osy, B dál.
	Obrys se zadává proti směru hodinových ručiček v rovině příčného řezu.  */
fn bud_solid cx A B mid uvs =
(
	local np = A.count
	if np >= 3 and B.count == np do
	(
		for k = 1 to np do
		(
			local m = ((mod k np) as integer) + 1
			bud_face cx #( A[k], A[m], B[m], B[k] ) mid uvs
		)
		-- Obrácený obrys se musí připravit do proměnné. "for ... collect" zapsaný
		-- přímo jako argument volání nedosáhne na parametr funkce (MAXScript
		-- hlásí "bad free thunk local member index").
		local Arev = #()
		for k = np to 1 by -1 do append Arev A[k]
		bud_face cx Arev mid uvs
		bud_face cx B mid uvs
	)
	ok
)

/*--- plochá střecha s atikou ------------------------------------------------*/
fn bud_strechaPlocha cx x0 x1 y0 y1 ze tl atikaV atikaT mKryt mKlemp uvs =
(
	pnl_addBox cx x0 y0 ze x1 y1 (ze + tl) mKryt uvs
	if atikaV > 0.01 do
	(
		local za = ze + tl
		local zc = za + atikaV
		local at2 = atikaT
		pnl_addBox cx x0 y0 za x1 (y0 + at2) zc mKryt uvs
		pnl_addBox cx x0 (y1 - at2) za x1 y1 zc mKryt uvs
		pnl_addBox cx x0 (y0 + at2) za (x0 + at2) (y1 - at2) zc mKryt uvs
		pnl_addBox cx (x1 - at2) (y0 + at2) za x1 (y1 - at2) zc mKryt uvs
		-- oplechování
		local ov = atikaT * 0.3
		local ot = atikaT * 0.2
		pnl_addBox cx (x0 - ov) (y0 - ov) zc (x1 + ov) (y0 + at2 + ov) (zc + ot) mKlemp uvs
		pnl_addBox cx (x0 - ov) (y1 - at2 - ov) zc (x1 + ov) (y1 + ov) (zc + ot) mKlemp uvs
		pnl_addBox cx (x0 - ov) (y0 + at2) zc (x0 + at2 + ov) (y1 - at2) (zc + ot) mKlemp uvs
		pnl_addBox cx (x1 - at2 - ov) (y0 + at2) zc (x1 + ov) (y1 - at2) (zc + ot) mKlemp uvs
	)
	ok
)

/*--- sedlová střecha (hřeben podél X) ---------------------------------------
	Staví se jako hranol s pětiúhelníkovým řezem, aby měla u okapu tloušťku
	a nekončila ostřím.                                                     */
fn bud_strechaSedlova cx x0 x1 y0 y1 ze vyska presah tl mKryt uvs =
(
	local ox0 = x0 - presah
	local ox1 = x1 + presah
	local oy0 = y0 - presah
	local oy1 = y1 + presah
	local yc = (y0 + y1) * 0.5
	local zr = ze + vyska
	-- Dvě spádové desky, ne plný blok: pod střechou zůstane podkroví, u okapu
	-- je vidět podhled a štít se ukáže v barvě fasády místo v barvě krytiny.
	local pL = #( [oy0, ze], [yc, zr], [yc, zr + tl], [oy0, ze + tl] )
	local pR = #( [yc, zr], [oy1, ze], [oy1, ze + tl], [yc, zr + tl] )
	local AL = for p in pL collect [ox0, p.x, p.y]
	local BL = for p in pL collect [ox1, p.x, p.y]
	bud_solid cx AL BL mKryt uvs
	local AR = for p in pR collect [ox0, p.x, p.y]
	local BR = for p in pR collect [ox1, p.x, p.y]
	bud_solid cx AR BR mKryt uvs
	ok
)

/*--- pultová střecha (spád k -Y) --------------------------------------------*/
fn bud_strechaPultova cx x0 x1 y0 y1 ze vyska presah tl mKryt uvs =
(
	local ox0 = x0 - presah
	local ox1 = x1 + presah
	local oy0 = y0 - presah
	local oy1 = y1 + presah
	local zr = ze + vyska
	local prof = #( [oy0, ze], [oy1, ze + vyska], [oy1, zr + tl], [oy0, ze + tl] )
	local A = for p in prof collect [ox0, p.x, p.y]
	local B = for p in prof collect [ox1, p.x, p.y]
	bud_solid cx A B mKryt uvs
	ok
)

/*--- valbová střecha --------------------------------------------------------
	Čtyři spádové plochy: dva lichoběžníky a dva trojúhelníky, zespodu
	uzavřené. Hřeben je zkrácený o stejný půdorysný běh, jaký má boční spád,
	takže všechny plochy mají stejný sklon.                                 */
fn bud_strechaValbova cx x0 x1 y0 y1 ze vyska presah tl mKryt uvs =
(
	local ox0 = x0 - presah
	local ox1 = x1 + presah
	local oy0 = y0 - presah
	local oy1 = y1 + presah
	local yc = (oy0 + oy1) * 0.5
	local zr = ze + vyska
	local run = (oy1 - oy0) * 0.5
	local rx0 = amin (ox0 + run) ((ox0 + ox1) * 0.5)
	local rx1 = amax (ox1 - run) ((ox0 + ox1) * 0.5)
	local zt = ze + tl
	-- spádové plochy
	bud_face cx #( [ox0, oy0, zt], [ox1, oy0, zt], [rx1, yc, zr], [rx0, yc, zr] ) mKryt uvs
	bud_face cx #( [ox1, oy1, zt], [ox0, oy1, zt], [rx0, yc, zr], [rx1, yc, zr] ) mKryt uvs
	bud_face cx #( [ox0, oy0, zt], [rx0, yc, zr], [ox0, oy1, zt] ) mKryt uvs
	bud_face cx #( [ox1, oy1, zt], [rx1, yc, zr], [ox1, oy0, zt] ) mKryt uvs
	-- okapová obruba a dno
	pnl_addBox cx ox0 oy0 ze ox1 oy1 zt mKryt uvs
	ok
)

/*--- stanová střecha (jehlan) -----------------------------------------------*/
fn bud_strechaStanova cx x0 x1 y0 y1 ze vyska presah tl mKryt uvs =
(
	local ox0 = x0 - presah
	local ox1 = x1 + presah
	local oy0 = y0 - presah
	local oy1 = y1 + presah
	local sx = (ox0 + ox1) * 0.5
	local sy = (oy0 + oy1) * 0.5
	local zr = ze + vyska
	local zt = ze + tl
	bud_face cx #( [ox0, oy0, zt], [ox1, oy0, zt], [sx, sy, zr] ) mKryt uvs
	bud_face cx #( [ox1, oy0, zt], [ox1, oy1, zt], [sx, sy, zr] ) mKryt uvs
	bud_face cx #( [ox1, oy1, zt], [ox0, oy1, zt], [sx, sy, zr] ) mKryt uvs
	bud_face cx #( [ox0, oy1, zt], [ox0, oy0, zt], [sx, sy, zr] ) mKryt uvs
	pnl_addBox cx ox0 oy0 ze ox1 oy1 zt mKryt uvs
	ok
)

/*--- štítová stěna pod sedlovou/pultovou střechou ---------------------------
	Obrys nad úrovní okapu, v tloušťce stěny. Výšky se zadávají tak, aby
	štít lícoval se spodkem střechy a nevznikla mezi nimi spára:
	zrA / zrB   = výška líce střechy nad hranou y0 / y1
	zrVrchol    = výška hřebene uprostřed; 0 (nebo <= ze) = bez hřebene    */
fn bud_stit cx xa xb y0 y1 ze zrA zrB zrVrchol mid uvs =
(
	local yc = (y0 + y1) * 0.5
	local prof = undefined
	if zrVrchol > ze then
		-- sedlová: obrys sleduje líc obou spádů i s hřebenem uprostřed
		prof = #( [y0, ze], [y1, ze], [y1, zrB], [yc, zrVrchol], [y0, zrA] )
	else
		-- pultová: lichoběžník, jedna strana nižší
		prof = #( [y0, ze], [y1, ze], [y1, zrB], [y0, zrA] )
	local A = for p in prof collect [xa, p.x, p.y]
	local B = for p in prof collect [xb, p.x, p.y]
	bud_solid cx A B mid uvs
	ok
)

/*--- komín ------------------------------------------------------------------*/
fn bud_komin cx xc yc s zd zh mid mKryt uvs =
(
	pnl_addBox cx (xc - s * 0.5) (yc - s * 0.5) zd (xc + s * 0.5) (yc + s * 0.5) zh mid uvs
	pnl_addBox cx (xc - s * 0.7) (yc - s * 0.7) zh (xc + s * 0.7) (yc + s * 0.7) (zh + s * 0.18) mKryt uvs
	ok
)

/*--- mřížka okenních otvorů na jedné fasádě ---------------------------------
	Vrátí pole point4 [a1,a2,z1,z2] pro podlaží f1..f2.                     */
fn bud_oknaGrid AX ow zb fh f1 f2 par oh =
(
	local ops = #()
	for f = f1 to f2 do
	(
		local zf = zb + (f - 1) * fh
		for xc in AX do append ops [ xc - ow * 0.5, xc + ow * 0.5, zf + par, zf + par + oh ]
	)
	ops
)

/*--- dozdívka podélných stěn pod šikmou střechu -----------------------------
	U pultové (a obecně tam, kde líc střechy nad stěnou neleží v úrovni
	okapu) by mezi stěnou a střechou zůstala díra. Tohle ji dozdí.
	zPredni / zZadni = výška líce střechy nad stěnou y0 / y1.               */
fn bud_dozdivka cx x0 x1 y0 y1 t ze zPredni zZadni mid uvs =
(
	if zPredni > ze + 1e-5 do pnl_addBox cx x0 y0 ze x1 (y0 + t) zPredni mid uvs
	if zZadni > ze + 1e-5 do pnl_addBox cx x0 (y1 - t) ze x1 y1 zZadni mid uvs
	ok
)

/*==================== půdorys ze splinu, obecné tvary ======================*/

/*--- triangulace mnohoúhelníku odřezáváním uší ------------------------------
	bud_face dělí plochu vějířem, což platí jen pro konvexní tvary. Atypický
	půdorys (L, U) konvexní není, proto tohle.
	pts = body v XY proti směru hodinových ručiček; vrací pole trojic indexů. */
fn bud_earClip pts =
(
	local np = pts.count
	local idx = for k = 1 to np collect k
	local tris = #()
	local guard = 0
	local pokracuj = true
	while idx.count > 3 and guard < np * np + 10 and pokracuj do
	(
		guard = guard + 1
		local nalezeno = false
		for i = 1 to idx.count while not nalezeno do
		(
			local ia = idx[(if i == 1 then idx.count else i - 1)]
			local ib = idx[i]
			local ic = idx[(if i == idx.count then 1 else i + 1)]
			local pa = pts[ia]
			local pb = pts[ib]
			local pc = pts[ic]
			local kriz = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x)
			if kriz > 1e-9 do
			(
				local cisty = true
				for j in idx while cisty do
					if j != ia and j != ib and j != ic do
					(
						local pp = pts[j]
						local d1 = (pb.x - pa.x) * (pp.y - pa.y) - (pb.y - pa.y) * (pp.x - pa.x)
						local d2 = (pc.x - pb.x) * (pp.y - pb.y) - (pc.y - pb.y) * (pp.x - pb.x)
						local d3 = (pa.x - pc.x) * (pp.y - pc.y) - (pa.y - pc.y) * (pp.x - pc.x)
						-- ostrá nerovnost: bod ležící přesně na hraně ucho neblokuje,
						-- jinak by kolineární body z lomené čáry zastavily dělení
						if d1 > 1e-9 and d2 > 1e-9 and d3 > 1e-9 do cisty = false
					)
				if cisty do
				(
					append tris #(ia, ib, ic)
					deleteItem idx i
					nalezeno = true
				)
			)
		)
		if not nalezeno do pokracuj = false
	)
	if idx.count == 3 do append tris #(idx[1], idx[2], idx[3])
	tris
)

/*--- odsazení obrysu ven o zadanou vzdálenost -------------------------------
	Vrcholy se posouvají po ose úhlu sousedních stran (miter), ne radiálně od
	těžiště - jinak by se tvary jako L nebo U pokřivily.                    */
fn bud_odsazObrys pts d =
(
	local np = pts.count
	local res = #()
	for k = 1 to np do
	(
		local pv = pts[(if k == 1 then np else k - 1)]
		local pc = pts[k]
		local pn = pts[(if k == np then 1 else k + 1)]
		local d1 = [ pc.x - pv.x, pc.y - pv.y, 0 ]
		local d2 = [ pn.x - pc.x, pn.y - pc.y, 0 ]
		if (length d1) < 1e-6 or (length d2) < 1e-6 then append res [ pc.x, pc.y, 0 ]
		else
		(
			d1 = normalize d1
			d2 = normalize d2
			local n1 = [ d1.y, -d1.x, 0 ]           -- vnější normála (obrys je CCW)
			local n2 = [ d2.y, -d2.x, 0 ]
			local bis = n1 + n2
			local bdel = length bis
			if bdel < 1e-6 then append res [ pc.x + n1.x * d, pc.y + n1.y * d, 0 ]
			else
			(
				bis = bis / bdel
				local kos = dot bis n1
				local mira = if kos > 0.2 then (d / kos) else d
				-- omezení délky zkosení, jinak u ostrých a zpětných rohů
				-- vystřelí vrchol do špice a obrys se protne sám se sebou
				local lim = (abs d) * 2.5
				if mira > lim do mira = lim
				if mira < -lim do mira = -lim
				append res [ pc.x + bis.x * mira, pc.y + bis.y * mira, 0 ]
			)
		)
	)
	res
)

/*--- vodorovná plocha z obecného (i konkávního) obrysu ----------------------
	pts3 = body proti směru hodinových ručiček při pohledu shora.
	dolu = true -> plocha kouká dolů (dno).                                 */
fn bud_facePoly cx pts3 mid uvs dolu =
(
	local np = pts3.count
	if np >= 3 do
	(
		local tris = bud_earClip pts3
		local o = cx.V.count
		for p in pts3 do append cx.V p
		local tb = cx.TV.count
		if uvs > 0 do for p in pts3 do append cx.TV [ p.x / uvs, p.y / uvs, 0 ]
		for tr in tris do
		(
			if dolu then append cx.F [ o + tr[1], o + tr[3], o + tr[2] ]
			else append cx.F [ o + tr[1], o + tr[2], o + tr[3] ]
			append cx.M mid
			append cx.S 0
			if uvs > 0 do
			(
				if dolu then append cx.TF [ tb + tr[1], tb + tr[3], tb + tr[2] ]
				else append cx.TF [ tb + tr[1], tb + tr[2], tb + tr[3] ]
			)
		)
	)
	ok
)

/*--- vytažení obrysu s proměnnou výškou -------------------------------------
	zdol / zhor = pole výšek pro každý bod obrysu (umožní i šikmý vrch).    */
fn bud_extrudeVar cx pts zdol zhor mid uvs =
(
	local np = pts.count
	if np >= 3 and zdol.count == np and zhor.count == np do
	(
		for k = 1 to np do
		(
			local m = ((mod k np) as integer) + 1
			local pa = pts[k]
			local pb = pts[m]
			bud_face cx #( [pa.x, pa.y, zdol[k]], [pb.x, pb.y, zdol[m]], \
						   [pb.x, pb.y, zhor[m]], [pa.x, pa.y, zhor[k]] ) mid uvs
		)
		/*	Dno se zadává ve stejném pořadí jako vrch (proti směru hodinových
			ručiček) - otočení zajistí příznak "dolu". Kdyby se body otočily
			navíc, dostal by ear clipping obrys po směru hodinových ručiček
			a vyrobil trojúhelníky mimo půdorys.                            */
		local dno = #()
		for k = 1 to np do append dno [ pts[k].x, pts[k].y, zdol[k] ]
		bud_facePoly cx dno mid uvs true
		local vrch = #()
		for k = 1 to np do append vrch [ pts[k].x, pts[k].y, zhor[k] ]
		bud_facePoly cx vrch mid uvs false
	)
	ok
)

/*--- obrys ze splinu --------------------------------------------------------
	deleni <= 1 : použijí se přímo vrcholy (přesné pro lomené čáry)
	deleni  > 1 : spline se navzorkuje (pro oblouky)                        */
fn bud_obrysZeSpline sh spl deleni =
(
	local pts = #()
	local nk = numKnots sh spl
	-- stačí jeden vrchol: tahle funkce slouží i pro značky dveří,
	-- volající si počet bodů pohlídá sám
	if nk >= 1 do
	(
		if deleni <= 1 then
			for k = 1 to nk do append pts (getKnotPoint sh spl k)
		else
		(
			local ns = nk * deleni
			for i = 0 to ns - 1 do append pts (interpCurve3D sh spl (i as float / ns))
		)
		/*	Podle verze Maxu a typu splinu vracejí tyhle funkce body buď
			v objektových, nebo rovnou ve světových souřadnicích. Místo hádání
			se výsledek porovná se skutečným obalovým kvádrem uzlu: když sedí,
			jsou body světové a transformace by posun započítala podruhé.   */
		if pts.count > 0 do
		(
			local mn = pts[1]
			local mx = pts[1]
			for p in pts do
			(
				mn = [ amin mn.x p.x, amin mn.y p.y, amin mn.z p.z ]
				mx = [ amax mx.x p.x, amax mx.y p.y, amax mx.z p.z ]
			)
			local stredP = (mn + mx) * 0.5
			local bb = nodeGetBoundingBox sh (matrix3 1)
			local stredN = (bb[1] + bb[2]) * 0.5
			local mera = (distance bb[1] bb[2]) * 0.02 + 0.001
			-- kromě posunu se porovnají i rozměry: otočený spline má
			-- v objektových souřadnicích jiný obalový kvádr než ve světových
			local rozmP = mx - mn
			local rozmN = bb[2] - bb[1]
			if (distance stredP stredN) > mera or (distance rozmP rozmN) > mera do
			(
				local tp = #()
				for p in pts do append tp (p * sh.transform)
				pts = tp
			)
		)
	)
	pts
)

/*--- nejbližší místo na obrysu k zadanému bodu ------------------------------
	Vrací #(index úseku, vzdálenost podél úseku). Používá se pro umístění
	dveří podle pomocného bodu, který si uživatel postaví kam chce.         */
fn bud_najdiNaObrysu obrys bod =
(
	local np = obrys.count
	local nejI = 1
	local nejT = 0.0
	local nejD = 1e12
	for k = 1 to np do
	(
		local m = ((mod k np) as integer) + 1
		local pa = obrys[k]
		local pb = obrys[m]
		local vv = [ pb.x - pa.x, pb.y - pa.y, 0 ]
		local dl = length vv
		if dl > 1e-6 do
		(
			local dv = vv / dl
			local w = [ bod.x - pa.x, bod.y - pa.y, 0 ]
			local tt = dot w dv
			if tt < 0 do tt = 0
			if tt > dl do tt = dl
			local dd = distance [ pa.x + dv.x * tt, pa.y + dv.y * tt, 0 ] [ bod.x, bod.y, 0 ]
			if dd < nejD do ( nejD = dd; nejI = k; nejT = tt )
		)
	)
	#( nejI, nejT )
)

/*--- úsek, jehož vnější normála nejlíp míří zadaným azimutem ---------------*/
fn bud_usekPodleSmeru obrys uhel =
(
	local np = obrys.count
	local cil = [ cos uhel, sin uhel, 0 ]
	local nejI = 1
	local nejS = -2.0
	for k = 1 to np do
	(
		local m = ((mod k np) as integer) + 1
		local vv = [ obrys[m].x - obrys[k].x, obrys[m].y - obrys[k].y, 0 ]
		if (length vv) > 1e-6 do
		(
			local dv = normalize vv
			local shoda = dot [ dv.y, -dv.x, 0 ] cil
			if shoda > nejS do ( nejS = shoda; nejI = k )
		)
	)
	nejI
)

/*--- body z uzlu: u splinu všechny vrcholy, jinak poloha objektu -----------*/
fn bud_bodyZUzlu nd =
(
	local res = #()
	if nd != undefined do
		try
		(
			if (superclassof nd) == shape then
				for s = 1 to (numSplines nd) do
					for p in (bud_obrysZeSpline nd s 1) do append res p
			else
				append res nd.pos
		)
		catch ( res = #() )
	res
)

/*--- výpis úseků obrysu do Listeneru ----------------------------------------
	Aby šlo rozumně používat zadání dveří číslem úseku.                     */
fn bud_vypisUseky obrys =
(
	local np = obrys.count
	format "\n--- úseky půdorysu (% celkem) ---\n" np
	for k = 1 to np do
	(
		local m = ((mod k np) as integer) + 1
		local vv = [ obrys[m].x - obrys[k].x, obrys[m].y - obrys[k].y, 0 ]
		local dl = length vv
		local az = 0.0
		if dl > 1e-6 do
		(
			local dv = vv / dl
			az = atan2 (-dv.x) dv.y
			if az < 0 do az = az + 360.0
		)
		format "úsek % : délka %, střed [%, %], vnější normála % st.\n" \
			k (dl as integer) (((obrys[k].x + obrys[m].x) * 0.5) as integer) \
			(((obrys[k].y + obrys[m].y) * 0.5) as integer) (az as integer)
	)
	ok
)

/*--- úklid obrysu: duplicity ven, orientace proti směru hodinových ručiček --*/
fn bud_uklidObrys pts eps =
(
	local res = #()
	for p in pts do
	(
		local vzit = true
		if res.count > 0 do
			if (distance p res[res.count]) < eps do vzit = false
		if vzit do append res p
	)
	if res.count > 2 do
		if (distance res[1] res[res.count]) < eps do deleteItem res res.count
	local plocha = 0.0
	local np = res.count
	for k = 1 to np do
	(
		local m = ((mod k np) as integer) + 1
		plocha = plocha + (res[k].x * res[m].y - res[m].x * res[k].y)
	)
	if plocha < 0 do
	(
		local rev = #()
		for k = np to 1 by -1 do append rev res[k]
		res = rev
	)
	res
)

/*--- prstenec mezi dvěma obrysy ---------------------------------------------
	Rohy doléhají, protože vnitřní obrys je zkosený (mitrovaný) - stavět to
	po úsecích jako samostatné kvádry dělá v rozích díry a přesahy.         */
fn bud_prstenec cx vnejsi vnitrni z1 z2 mid uvs =
(
	local np = vnejsi.count
	if np >= 3 and vnitrni.count == np do
		for k = 1 to np do
		(
			local m = ((mod k np) as integer) + 1
			local rohA = vnejsi[k]
			local rohB = vnejsi[m]
			local rohC = vnitrni[m]
			local rohD = vnitrni[k]
			bud_face cx #( [rohA.x,rohA.y,z1], [rohB.x,rohB.y,z1], [rohB.x,rohB.y,z2], [rohA.x,rohA.y,z2] ) mid uvs
			bud_face cx #( [rohD.x,rohD.y,z1], [rohD.x,rohD.y,z2], [rohC.x,rohC.y,z2], [rohC.x,rohC.y,z1] ) mid uvs
			bud_face cx #( [rohA.x,rohA.y,z2], [rohB.x,rohB.y,z2], [rohC.x,rohC.y,z2], [rohD.x,rohD.y,z2] ) mid uvs
			bud_face cx #( [rohA.x,rohA.y,z1], [rohD.x,rohD.y,z1], [rohC.x,rohC.y,z1], [rohB.x,rohB.y,z1] ) mid uvs
		)
	ok
)

/*--- kus stěny mezi dvěma otvory, se zkosenými konci ------------------------
	pa = vnější počátek úseku, dv = jednotkový směr, dl = délka úseku,
	qa/qb = odpovídající body vnitřního (odsazeného) obrysu. Vnitřní líc se
	mezi nimi interpoluje, takže na rozích navazuje bez díry i přesahu.     */
fn bud_stenaKus cx pa dv qa qb dl a1 a2 z1 z2 mid uvs =
(
	if dl > 1e-5 and (a2 - a1) > 1e-5 and (z2 - z1) > 1e-5 do
	(
		local vA = pa + dv * a1
		local vB = pa + dv * a2
		local wA = qa + (qb - qa) * (a1 / dl)
		local wB = qa + (qb - qa) * (a2 / dl)
		local pts = #( [vA.x,vA.y,0], [vB.x,vB.y,0], [wB.x,wB.y,0], [wA.x,wA.y,0] )
		local zd = #( z1, z1, z1, z1 )
		local zh = #( z2, z2, z2, z2 )
		bud_extrudeVar cx pts zd zh mid uvs
	)
	ok
)

/*--- kvádr v soustavě jednoho úseku stěny -----------------------------------
	org = počátek úseku, dv = směr podél stěny, nv = směr dovnitř (oba
	jednotkové a na sebe kolmé). Souřadnice a/p/z se chovají jako x/y/z.   */
fn bud_addBoxLoc cx org dv nv a1 p1 z1 a2 p2 z2 mid uvs =
(
	local qa1 = amin a1 a2, qa2 = amax a1 a2
	local qp1 = amin p1 p2, qp2 = amax p1 p2
	local qz1 = amin z1 z2, qz2 = amax z1 z2
	if (qa2 - qa1) > 1e-5 and (qp2 - qp1) > 1e-5 and (qz2 - qz1) > 1e-5 do
	(
		local P = #()
		append P (org + dv * qa1 + nv * qp1 + [0, 0, qz1])
		append P (org + dv * qa2 + nv * qp1 + [0, 0, qz1])
		append P (org + dv * qa2 + nv * qp2 + [0, 0, qz1])
		append P (org + dv * qa1 + nv * qp2 + [0, 0, qz1])
		append P (org + dv * qa1 + nv * qp1 + [0, 0, qz2])
		append P (org + dv * qa2 + nv * qp1 + [0, 0, qz2])
		append P (org + dv * qa2 + nv * qp2 + [0, 0, qz2])
		append P (org + dv * qa1 + nv * qp2 + [0, 0, qz2])
		bud_face cx #( P[1], P[4], P[3], P[2] ) mid uvs
		bud_face cx #( P[5], P[6], P[7], P[8] ) mid uvs
		bud_face cx #( P[1], P[2], P[6], P[5] ) mid uvs
		bud_face cx #( P[2], P[3], P[7], P[6] ) mid uvs
		bud_face cx #( P[3], P[4], P[8], P[7] ) mid uvs
		bud_face cx #( P[4], P[1], P[5], P[8] ) mid uvs
	)
	ok
)

/*--- výplň otvoru v šikmé stěně: sklo, rám, sloupky, parapet ---------------*/
fn bud_vyplnSeg cx org dv nv o kind det mGlass uvs =
(
	local a1 = o.x, a2 = o.y, z1 = o.z, z2 = o.w
	local U = det.U
	if (a2 - a1) > 0.1 * U and (z2 - z1) > 0.1 * U do
	(
		local fw = if det.ramy then det.ram else 0.0
		local pa = det.zapusteni
		local gt = amax (0.02 * U) (fw * 0.6)
		local qa = pa - amax (0.02 * U) (fw * 0.4)
		local qb = pa + amax (0.03 * U) (fw * 0.9)
		local mR = if kind == 3 then PNL_MAT_DVERE else PNL_MAT_RAM
		bud_addBoxLoc cx org dv nv (a1 + fw) pa (z1 + fw) (a2 - fw) (pa + gt) (z2 - fw) mGlass uvs
		if det.ramy do
		(
			bud_addBoxLoc cx org dv nv a1 qa z1 (a1 + fw) qb z2 mR uvs
			bud_addBoxLoc cx org dv nv (a2 - fw) qa z1 a2 qb z2 mR uvs
			bud_addBoxLoc cx org dv nv (a1 + fw) qa z1 (a2 - fw) qb (z1 + fw) mR uvs
			bud_addBoxLoc cx org dv nv (a1 + fw) qa (z2 - fw) (a2 - fw) qb z2 mR uvs
			if kind != 3 then
			(
				local nd = amax 1 det.deleni
				for k = 1 to nd - 1 do
				(
					local am = a1 + (a2 - a1) * k / nd
					bud_addBoxLoc cx org dv nv (am - fw * 0.45) qa (z1 + fw) (am + fw * 0.45) qb (z2 - fw) mR uvs
				)
			)
			else
			(
				-- vstupní dveře: dělicí sloupek a spodní panel
				local am = (a1 + a2) * 0.5
				bud_addBoxLoc cx org dv nv (am - fw * 0.6) qa (z1 + fw) (am + fw * 0.6) qb (z2 - fw) mR uvs
				bud_addBoxLoc cx org dv nv (a1 + fw) qa (z1 + fw) (a2 - fw) qb (z1 + 0.45 * U) mR uvs
			)
		)
		if det.parapetPlech and kind != 3 do
			bud_addBoxLoc cx org dv nv (a1 - det.parapetPresah) (-det.parapetPresah) (z1 - det.parapetTl) \
				(a2 + det.parapetPresah) (pa + fw) z1 PNL_MAT_KLEMP uvs
	)
	ok
)

/*--- vodorovná římsa po obvodu ----------------------------------------------*/
fn bud_rimsa cx x0 x1 y0 y1 z vys presah mid uvs =
(
	pnl_addBox cx (x0 - presah) (y0 - presah) z (x1 + presah) (y1 + presah) (z + vys) mid uvs
	ok
)

format "Budovy: knihovna načtena.\n"
