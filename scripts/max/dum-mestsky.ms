/*------------------------------------------------------------------------------
	MĚSTSKÝ DŮM (činžák) - parametrický generátor pro 3ds Max
	---------------------------------------------------------
	Klasický městský dům do ulice: v přízemí obchodní parter s výlohami a
	vchodem, nad ním bytová podlaží s okny, mezi nimi kordonová římsa, nahoře
	hlavní římsa a plochá nebo sedlová střecha. Volitelně šambrány kolem oken
	a francouzská okna s kovaným zábradlíčkem.

	Create > Geometry > kategorie "Budovy" > Městský dům, pak klik do pohledu.
	Rozměry v metrech. Potřebuje budovy-lib.ms a panelak.ms ve stejné složce.
------------------------------------------------------------------------------*/

(
	local md_dir = ""
	try ( md_dir = getFilenamePath (getSourceFileName()) ) catch ( md_dir = "" )
	local md_lib = md_dir + "budovy-lib.ms"
	if md_dir != "" and (doesFileExist md_lib) then fileIn md_lib
	else format "CHYBA: vedle dum-mestsky.ms musí ležet budovy-lib.ms a panelak.ms\n"
)

global dumMestskySetParam

plugin simpleObject DumMestskyGeo
	name:"Městský dům"
	classID:#(0x51ab33d2, 0x2d7f9112)
	category:"Budovy"
	version:1
(
	tool create
	(
		on mousePoint click do
		(
			nodeTM.translation = gridPoint
			#stop
		)
	)

	parameters pRozmery rollout:rMain
	(
		delka        type:#float   ui:spDelka    default:22.0
		sirka        type:#float   ui:spSirka    default:14.0
		podlazi      type:#integer ui:spPodlazi  default:5
		vyskaPodlazi type:#float   ui:spVyskaP   default:3.2
		tlSteny      type:#float   ui:spTlSteny  default:0.45
	)

	parameters pParter rollout:rParter
	(
		parterVyska  type:#float   ui:spParterV  default:4.2
		vylohaVyska  type:#float   ui:spVylohaV  default:3.0
		vylohaParapet type:#float  ui:spVylohaP  default:0.45
		pocetObchodu type:#integer ui:spObchodu  default:2
		markyza      type:#boolean ui:chkMarkyza default:true
		vchodSirka   type:#float   ui:spVchodS   default:1.8
		obklad       type:#boolean ui:chkObklad  default:true
	)

	parameters pOkna rollout:rOkna
	(
		rozponOsy   type:#float   ui:spRozpon   default:2.9
		oknoSirka   type:#float   ui:spOknoS    default:1.4
		oknoVyska   type:#float   ui:spOknoV    default:1.9
		parapet     type:#float   ui:spParapet  default:0.85
		oknoDeleni  type:#integer ui:spDeleni   default:2
		nadsvetlik  type:#boolean ui:chkNadsv   default:true
		sambrany    type:#boolean ui:chkSambr   default:true
		sambranaSir type:#float   ui:spSambrS   default:0.16
		francouzska type:#boolean ui:chkFranc   default:true
		francKrok   type:#integer ui:spFrancK   default:3
	)

	parameters pRimsy rollout:rRimsy
	(
		kordonRimsa type:#boolean ui:chkKordon  default:true
		hlavniRimsa type:#boolean ui:chkHlavni  default:true
		rimsaVyska  type:#float   ui:spRimsaV   default:0.32
		rimsaPresah type:#float   ui:spRimsaP   default:0.28
		typStrechy  type:#integer ui:ddlStrecha default:1
		sklon       type:#float   ui:spSklon    default:38.0
		atikaVyska  type:#float   ui:spAtika    default:0.7
	)

	parameters pMat rollout:rMat
	(
		mapovani   type:#boolean ui:chkMapovani default:true
		uvMeritko  type:#float   ui:spUV        default:1.0
		unitsPerM  type:#float   ui:spJednotky  default:1.0
		trubkaHran type:#integer ui:spHran      default:8
		seed       type:#integer ui:spSeed      default:1
	)

	rollout rMain "Rozměry domu"
	(
		spinner spDelka "Délka do ulice (m):" type:#float range:[6,120,22] scale:0.25 fieldwidth:58
		slider  slDelka "" type:#float range:[6,120,22] ticks:0 width:150 offset:[0,-3]
		spinner spSirka "Hloubka (m):" type:#float range:[6,40,14] scale:0.25 fieldwidth:58
		slider  slSirka "" type:#float range:[6,40,14] ticks:0 width:150 offset:[0,-3]
		spinner spPodlazi "Bytových podlaží:" type:#integer range:[1,12,5] fieldwidth:58
		slider  slPodlazi "" type:#integer range:[1,12,5] ticks:0 width:150 offset:[0,-3]
		spinner spVyskaP "Výška podlaží (m):" type:#float range:[2.4,5,3.2] scale:0.05 fieldwidth:58
		spinner spTlSteny "Tloušťka stěn (m):" type:#float range:[0.15,1.2,0.45] scale:0.01 fieldwidth:58

		on slDelka changed val do dumMestskySetParam #delka val
		on slSirka changed val do dumMestskySetParam #sirka val
		on slPodlazi changed val do dumMestskySetParam #podlazi val
		on rMain open do
			try ( slDelka.value = delka; slSirka.value = sirka; slPodlazi.value = podlazi )
			catch ()
	)

	rollout rParter "Parter (obchody)"
	(
		label lbP "Přízemí je obchodní, byty až nad ním."
		spinner spParterV "Výška parteru (m):" type:#float range:[2.6,7,4.2] scale:0.1 fieldwidth:58
		slider  slParterV "" type:#float range:[2.6,7,4.2] ticks:0 width:150 offset:[0,-3]
		spinner spVylohaV "Výška výlohy (m):" type:#float range:[1.5,6,3.0] scale:0.1 fieldwidth:58
		spinner spVylohaP "Parapet výlohy (m):" type:#float range:[0,1.5,0.45] scale:0.05 fieldwidth:58
		spinner spObchodu "Počet obchodů:" type:#integer range:[1,10,2] fieldwidth:58
		spinner spVchodS "Šířka vchodu do domu (m):" type:#float range:[0.9,4,1.8] scale:0.05 fieldwidth:58
		checkbox chkMarkyza "Markýzy nad výlohami" checked:true
		checkbox chkObklad "Obklad parteru (jiný materiál)" checked:true

		on slParterV changed val do dumMestskySetParam #parterVyska val
		on rParter open do try (slParterV.value = parterVyska) catch ()
	)

	rollout rOkna "Okna bytových podlaží"
	(
		spinner spRozpon "Rozteč os (m):" type:#float range:[1.5,8,2.9] scale:0.1 fieldwidth:58
		spinner spOknoS "Šířka okna (m):" type:#float range:[0.5,4,1.4] scale:0.05 fieldwidth:58
		spinner spOknoV "Výška okna (m):" type:#float range:[0.6,3.5,1.9] scale:0.05 fieldwidth:58
		spinner spParapet "Parapet (m):" type:#float range:[0,2,0.85] scale:0.05 fieldwidth:58
		spinner spDeleni "Křídel v okně:" type:#integer range:[1,4,2] fieldwidth:58
		checkbox chkNadsv "Nadsvětlík" checked:true
		checkbox chkSambr "Šambrány kolem oken" checked:true
		spinner spSambrS "Šířka šambrány (m):" type:#float range:[0.05,0.5,0.16] scale:0.01 fieldwidth:58
		checkbox chkFranc "Francouzská okna se zábradlím" checked:true
		spinner spFrancK "Na každé N-té ose:" type:#integer range:[1,6,3] fieldwidth:58
	)

	rollout rRimsy "Římsy a střecha"
	(
		checkbox chkKordon "Kordonová římsa nad parterem" checked:true
		checkbox chkHlavni "Hlavní římsa pod střechou" checked:true
		spinner spRimsaV "Výška římsy (m):" type:#float range:[0.1,1,0.32] scale:0.02 fieldwidth:58
		spinner spRimsaP "Přesah římsy (m):" type:#float range:[0.05,1,0.28] scale:0.02 fieldwidth:58
		dropdownlist ddlStrecha "" width:160 selection:1 items:#("plochá s atikou", "sedlová", "valbová")
		spinner spSklon "Sklon (°):" type:#float range:[10,60,38] scale:1 fieldwidth:58
		spinner spAtika "Výška atiky (m):" type:#float range:[0,2,0.7] scale:0.05 fieldwidth:58
	)

	rollout rMat "Materiál a mapování"
	(
		checkbox chkMapovani "Generovat UV mapování" checked:true
		spinner spUV "Velikost dlaždice UV (m):" type:#float range:[0.05,20,1.0] scale:0.1 fieldwidth:58
		spinner spJednotky "1 m = ... jednotek:" type:#float range:[0.0001,10000,1.0] scale:1 fieldwidth:58
		spinner spHran "Hran trubek:" type:#integer range:[4,16,8] fieldwidth:58
		spinner spSeed "Seed (číslo varianty):" type:#integer range:[0,999,1] fieldwidth:58
		button btnMat "Vytvořit a přiřadit materiál" width:170 height:22 offset:[0,4]
		button btnPoly "Vytvořit Editable Poly (kopii)" width:170 height:22 offset:[0,3]

		on btnMat pressed do panelakMaterial()
		on btnPoly pressed do panelakToPoly()
	)

	on buildMesh do
	(
		local cx = pnl_ctx()
		cx.V = #(); cx.F = #(); cx.M = #(); cx.TV = #(); cx.TF = #(); cx.S = #()
		local U  = amax 0.0001 unitsPerM
		local uv = if mapovani then (amax 0.001 (uvMeritko * U)) else 0.0

		local L  = amax (5.0 * U) (delka * U)
		local W  = amax (5.0 * U) (sirka * U)
		local NF = amax 1 podlazi
		local fh = amax (2.2 * U) (vyskaPodlazi * U)
		local t  = amin (amax (0.12 * U) (tlSteny * U)) (amin (L * 0.2) (W * 0.2))
		local pv = amax (2.4 * U) (parterVyska * U)     -- výška parteru
		local mrg = 0.25 * U

		local x0 = -L * 0.5, x1 = L * 0.5
		local y0 = -W * 0.5, y1 = W * 0.5
		local ze = pv + NF * fh                          -- horní hrana stěn

		-- osy bytových podlaží
		local n = amax 1 ((floor (L / (amax (1.0 * U) (rozponOsy * U)) + 0.5)) as integer)
		local stepX = L / n
		local AX = for i = 1 to n collect (x0 + stepX * (i - 0.5))
		local oh = amin (amax (0.3 * U) (oknoVyska * U)) (fh - 0.45 * U)
		local ow = amin (amax (0.3 * U) (oknoSirka * U)) (stepX - 0.5 * U)
		local par = amax 0.0 (amin (parapet * U) (fh - oh - 0.3 * U))

		local nY = amax 1 ((floor (W / (amax (1.0 * U) (rozponOsy * U)) + 0.5)) as integer)
		local stepY = W / nY
		local AY = for i = 1 to nY collect (y0 + stepY * (i - 0.5))
		local owY = amin ow (stepY - 0.5 * U)

		local fw = 0.075 * U
		local ins = amin (0.17 * U) (t - fw * 1.2)
		if ins < 0.0 do ins = 0.0

		local det = pnl_det()
		det.U = U
		det.ramy = true
		det.ram = fw
		det.zapusteni = ins
		det.deleni = amax 1 oknoDeleni
		det.nadsvetlik = nadsvetlik
		det.nadsvetlikV = 0.42 * U
		det.parapetPlech = true
		det.parapetTl = 0.04 * U
		det.parapetPresah = 0.07 * U
		det.balkonParapet = par
		det.dverKridla = 2
		det.dverNadsvetlik = true
		det.dverNadsvetlikV = 0.6 * U

		/*--- PARTER: výlohy a vchod do domu ---*/
		local nob = amax 1 pocetObchodu
		local vyV = amin (vylohaVyska * U) (pv - 0.6 * U)
		local vyP = amax 0.0 (amin (vylohaParapet * U) (pv - vyV - 0.3 * U))
		local vchS = amin (vchodSirka * U) (L / (nob + 1) - 0.4 * U)
		local xv = x0 + L * 0.5 - (L / (nob + 1)) * 0.5   -- vchod mimo střed sekcí

		local opsP = #()
		local kndP = #()
		-- vchod do domu vlevo od středu
		local xvch = x0 + L / (nob + 1) * 0.5
		if vchS > 0.6 * U do
		(
			append opsP [ xvch - vchS * 0.5, xvch + vchS * 0.5, 0, amin (2.6 * U) (pv - 0.5 * U) ]
			append kndP 3
		)
		-- výlohy mezi pilíři
		local pil = amax (0.4 * U) (L * 0.02)
		for k = 1 to nob do
		(
			local sa = x0 + (L / (nob + 1)) * k
			local sb = sa + (L / (nob + 1))
			if k == nob do sb = x1
			local ga = sa + pil * 0.5
			local gb = sb - pil * 0.5
			if gb - ga > 0.8 * U do
			(
				append opsP [ ga, gb, vyP, vyP + vyV ]
				append kndP 1
			)
		)

		/*--- otvory bytových podlaží ---*/
		local opsF = #()
		local kndF = #()
		for f = 1 to NF do
		(
			local zf = pv + (f - 1) * fh
			for i = 1 to n do
			(
				local isFr = francouzska and ((mod (i - 1) (amax 1 francKrok)) < 0.5) and f < NF
				if isFr then
				(
					append opsF [ AX[i] - ow * 0.5, AX[i] + ow * 0.5, zf + 0.1 * U, zf + par + oh ]
					append kndF 2
				)
				else
				(
					append opsF [ AX[i] - ow * 0.5, AX[i] + ow * 0.5, zf + par, zf + par + oh ]
					append kndF 1
				)
			)
		)
		local opsB = bud_oknaGrid AX ow pv fh 1 NF par oh
		local opsG = bud_oknaGrid AY owY pv fh 1 NF par oh

		/*--- stěny parteru ---*/
		local mParter = if obklad then PNL_MAT_SOKL else PNL_MAT_FASADA
		local PR = pnl_wallRects x0 x1 0 pv opsP
		for r in PR do pnl_addBox cx r.x y0 r.z r.y (y0 + t) r.w mParter uv
		pnl_addBox cx x0 (y1 - t) 0 x1 y1 pv mParter uv
		pnl_addBox cx x0 (y0 + t) 0 (x0 + t) (y1 - t) pv mParter uv
		pnl_addBox cx (x1 - t) (y0 + t) 0 x1 (y1 - t) pv mParter uv
		pnl_addBox cx x0 y0 (-0.3 * U) x1 y1 0 PNL_MAT_SOKL uv

		for j = 1 to opsP.count do
			pnl_fillOpening cx opsP[j] kndP[j] true y0 1.0 det PNL_MAT_SKLO uv

		-- markýzy nad výlohami
		if markyza do
			for j = 1 to opsP.count do
				if kndP[j] == 1 do
				(
					local o = opsP[j]
					pnl_addBox cx (o.x - 0.1 * U) (y0 - 1.1 * U) (o.w + 0.1 * U) \
						(o.y + 0.1 * U) (y0 + t * 0.4) (o.w + 0.28 * U) PNL_MAT_DROBNOSTI uv
				)

		/*--- stěny bytových podlaží ---*/
		local R = pnl_wallRects x0 x1 pv ze opsF
		for r in R do pnl_addBox cx r.x y0 r.z r.y (y0 + t) r.w PNL_MAT_FASADA uv
		R = pnl_wallRects x0 x1 pv ze opsB
		for r in R do pnl_addBox cx r.x (y1 - t) r.z r.y y1 r.w PNL_MAT_FASADA uv
		R = pnl_wallRects (y0 + t) (y1 - t) pv ze opsG
		for r in R do
		(
			pnl_addBox cx x0 r.x r.z (x0 + t) r.y r.w PNL_MAT_FASADA uv
			pnl_addBox cx (x1 - t) r.x r.z x1 r.y r.w PNL_MAT_FASADA uv
		)
		pnl_addBox cx x0 y0 (ze - 0.3 * U) x1 y1 ze PNL_MAT_DESKA uv

		/*--- výplně otvorů ---*/
		for j = 1 to opsF.count do
			pnl_fillOpening cx opsF[j] kndF[j] true y0 1.0 det PNL_MAT_SKLO uv
		for o in opsB do pnl_fillOpening cx o 1 true y1 (-1.0) det PNL_MAT_SKLO uv
		for o in opsG do
		(
			pnl_fillOpening cx o 1 false x0 1.0 det PNL_MAT_SKLO uv
			pnl_fillOpening cx o 1 false x1 (-1.0) det PNL_MAT_SKLO uv
		)

		/*--- šambrány kolem oken uliční fasády ---*/
		if sambrany do
		(
			local sw2 = amax (0.03 * U) (sambranaSir * U)
			local sd2 = 0.05 * U
			for j = 1 to opsF.count do
			(
				local o = opsF[j]
				pnl_addBox cx (o.x - sw2) (y0 - sd2) (o.z - sw2) (o.x) (y0 + t * 0.3) (o.w + sw2) BUD_MAT_RIMSA uv
				pnl_addBox cx (o.y) (y0 - sd2) (o.z - sw2) (o.y + sw2) (y0 + t * 0.3) (o.w + sw2) BUD_MAT_RIMSA uv
				pnl_addBox cx (o.x - sw2) (y0 - sd2) (o.w) (o.y + sw2) (y0 + t * 0.3) (o.w + sw2) BUD_MAT_RIMSA uv
			)
		)

		/*--- zábradlíčka francouzských oken ---*/
		local hr = amax 4 trubkaHran
		for j = 1 to opsF.count do
			if kndF[j] == 2 do
			(
				local o = opsF[j]
				local zg = o.z + 1.0 * U
				local yg = y0 - 0.1 * U
				pnl_addPipe2 cx [o.x, yg, zg] [o.y, yg, zg] (0.022 * U) hr PNL_MAT_ZABRADLI uv
				pnl_addPipe2 cx [o.x, yg, o.z + 0.1 * U] [o.y, yg, o.z + 0.1 * U] (0.018 * U) hr PNL_MAT_ZABRADLI uv
				local nb = amax 3 ((floor ((o.y - o.x) / (0.14 * U))) as integer)
				for q = 0 to nb do
				(
					local bx = o.x + (o.y - o.x) * q / nb
					pnl_addPipe2 cx [bx, yg, o.z + 0.05 * U] [bx, yg, zg] (0.011 * U) hr PNL_MAT_ZABRADLI uv
				)
			)

		/*--- římsy ---*/
		local rv = amax (0.06 * U) (rimsaVyska * U)
		local rp = amax (0.03 * U) (rimsaPresah * U)
		if kordonRimsa do bud_rimsa cx x0 x1 y0 y1 (pv - rv * 0.5) rv (rp * 0.6) BUD_MAT_RIMSA uv
		if hlavniRimsa do bud_rimsa cx x0 x1 y0 y1 (ze - rv) (rv * 1.4) rp BUD_MAT_RIMSA uv

		/*--- střecha ---*/
		local ktl = 0.25 * U
		local sk = amax 5.0 (amin sklon 70.0)
		local tg = tan sk
		local prs = rp * 1.2
		local vysS = ((W * 0.5) + prs) * tg
		local zOkap = ze + prs * tg
		case typStrechy of
		(
			2: (
				bud_strechaSedlova cx x0 x1 y0 y1 ze vysS prs ktl BUD_MAT_KRYTINA uv
				bud_dozdivka cx x0 x1 y0 y1 t ze zOkap zOkap PNL_MAT_FASADA uv
				bud_stit cx x0 (x0 + t) y0 y1 ze zOkap zOkap (ze + vysS) PNL_MAT_FASADA uv
				bud_stit cx (x1 - t) x1 y0 y1 ze zOkap zOkap (ze + vysS) PNL_MAT_FASADA uv
			)
			3: bud_strechaValbova cx x0 x1 y0 y1 ze vysS prs ktl BUD_MAT_KRYTINA uv
			default: bud_strechaPlocha cx x0 x1 y0 y1 ze ktl (amax 0.0 (atikaVyska * U)) (amax (0.12 * U) (t * 0.5)) \
				PNL_MAT_STRECHA PNL_MAT_KLEMP uv
		)

		/*--- sestavení meshe ---*/
		if cx.V.count < 3 do pnl_addBox cx x0 y0 0 x1 y1 (1.0 * U) PNL_MAT_FASADA uv
		local vc = cx.V.count
		local fc = cx.F.count
		setMesh mesh numVerts:vc numFaces:fc
		for i = 1 to vc do setVert mesh i cx.V[i]
		for i = 1 to fc do
		(
			setFace mesh i cx.F[i]
			setFaceMatID mesh i cx.M[i]
			setFaceSmoothGroup mesh i (if i <= cx.S.count then cx.S[i] else 0)
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
			setNumTVerts mesh cx.TV.count
			buildTVFaces mesh
			if (getNumTVerts mesh) != cx.TV.count do setNumTVerts mesh cx.TV.count
			for i = 1 to cx.TV.count do setTVert mesh i cx.TV[i]
			for i = 1 to fc do setTVFace mesh i cx.TF[i]
		)
		update mesh
	)
)

fn dumMestskySetParam pname val =
(
	for o in (selection as array) where (isKindOf o DumMestskyGeo) do setProperty o pname val
	ok
)

macroScript DumMestskyCreate
	category:"Budovy"
	buttonText:"Mestsky dum"
	tooltip:"Vytvorit parametricky mestsky dum s parterem"
(
	on execute do
	(
		local dnode = DumMestskyGeo name:(uniquename "MestskyDum")
		select dnode
		max modify mode
	)
)

format "\nMěstský dům: plugin načten. Create > Geometry > kategorie \"Budovy\".\n"
