/*------------------------------------------------------------------------------
	DŮM PODLE PŮDORYSU (spline) - parametrický generátor pro 3ds Max
	----------------------------------------------------------------
	Místo obdélníku si půdorys nakreslíš splinem - klidně do L, U nebo
	jakéhokoliv atypického tvaru. Dům se po obrysu obtáhne stěnami, rozmístí
	okna po zadané rozteči, do nejdelšího úseku dá vstupní dveře a nasadí
	plochou nebo pultovou střechu.

	Postup:
		1) Nakresli uzavřený spline (Create > Shapes > Line) v půdorysu.
		2) Scripting > Run Script... -> dum-spline.ms
		3) Create > Geometry > kategorie "Budovy" > Dům podle půdorysu,
		   klikni do pohledu (objekt vznikne v počátku).
		4) V rollupu "Půdorys" vyber tlačítkem nakreslený spline.

	DŮLEŽITÉ: dům se staví ve světových souřadnicích splinu, takže objekt
	nech v počátku. Když spline pak upravíš, zmáčkni "Přepočítat podle splinu".

	Sedlová a valbová střecha tu nejsou - na obecný tvar je nelze odvodit bez
	konstrukce střešní osnovy. Pro ty použij dum-rodinny.ms.

	Potřebuje budovy-lib.ms a panelak.ms ve stejné složce.
------------------------------------------------------------------------------*/

(
	local ds_dir = ""
	try ( ds_dir = getFilenamePath (getSourceFileName()) ) catch ( ds_dir = "" )
	local ds_lib = ds_dir + "budovy-lib.ms"
	if ds_dir != "" and (doesFileExist ds_lib) then fileIn ds_lib
	else format "CHYBA: vedle dum-spline.ms musí ležet budovy-lib.ms a panelak.ms\n"
)

global dumSplineSetParam
global dumSplineJmenaZnacek

plugin simpleObject DumSplineGeo
	name:"Dům podle půdorysu"
	classID:#(0x51ab33d5, 0x2d7f9115)
	category:"Budovy"
	version:1
(
	tool create
	(
		on mousePoint click do
		(
			-- staví se ve světových souřadnicích splinu, proto počátek
			nodeTM.translation = [0, 0, 0]
			#stop
		)
	)

	parameters pPudorys rollout:rPudorys
	(
		pudorys    type:#node    ui:btnSpline
		deleni     type:#integer ui:spDeleni   default:1
		verze      type:#integer               default:0
		vycentrovat type:#boolean ui:chkCentr  default:false
	)

	parameters pRozmery rollout:rMain
	(
		podlazi      type:#integer ui:spPodlazi  default:2
		vyskaPodlazi type:#float   ui:spVyskaP   default:2.8
		tlSteny      type:#float   ui:spTlSteny  default:0.4
		podezdivka   type:#float   ui:spPodez    default:0.45
		soklPresah   type:#float   ui:spSoklP    default:0.06
		stropy       type:#boolean ui:chkStropy  default:true
	)

	parameters pOkna rollout:rOkna
	(
		rozponOsy    type:#float   ui:spRozpon   default:3.0
		oknoSirka    type:#float   ui:spOknoS    default:1.5
		oknoVyska    type:#float   ui:spOknoV    default:1.4
		parapet      type:#float   ui:spParapet  default:0.9
		oknoDeleni   type:#integer ui:spDeleni2  default:2
		ramy         type:#boolean ui:chkRamy    default:true
		parapetPlech type:#boolean ui:chkParapet default:true
		sklozap      type:#float   ui:spZapust   default:0.16
		odstupRohu   type:#float   ui:spOdstup   default:0.8
	)

	parameters pDvere rollout:rDvere
	(
		dvere      type:#boolean ui:chkDvere   default:true
		dverSirka  type:#float   ui:spDverS    default:1.2
		dverVyska  type:#float   ui:spDverV    default:2.1
		dverRezim  type:#integer ui:ddlRezim   default:1
		dverUsek   type:#integer ui:spUsek     default:1
		dverPozice type:#float   ui:spPozice   default:0.5
		dverSmer   type:#float   ui:spSmer2    default:180.0
		-- seznam značek: kolik objektů, tolik vchodů
		dverZnacky type:#nodeTab tabSize:0 tabSizeVariable:true
	)

	parameters pStrecha rollout:rStrecha
	(
		typStrechy type:#integer ui:ddlTyp     default:1
		presah     type:#float   ui:spPresah   default:0.5
		krytinaTl  type:#float   ui:spKrytTl   default:0.3
		atikaVyska type:#float   ui:spAtika    default:0.5
		atikaTl    type:#float   ui:spAtikaT   default:0.25
		sklon      type:#float   ui:spSklon    default:12.0
		smerSpadu  type:#float   ui:spSmer     default:0.0
	)

	parameters pMat rollout:rMat
	(
		mapovani   type:#boolean ui:chkMapovani default:true
		uvMeritko  type:#float   ui:spUV        default:1.0
		unitsPerM  type:#float   ui:spJednotky  default:1.0
	)

	rollout rPudorys "Půdorys"
	(
		pickbutton btnSpline "Vybrat spline půdorysu" width:170 height:24 autoDisplay:true
		label lb1 "Uzavřený spline, nakreslený v půdorysu."
		spinner spDeleni "Dělení oblouků:" type:#integer range:[1,20,1] fieldwidth:58
		label lb2 "1 = jen vrcholy (lomená čára)," offset:[0,1]
		label lb3 "víc = navzorkuje i oblouky." offset:[0,0]
		button btnRefresh "Přepočítat podle splinu" width:170 height:22 offset:[0,5]
		checkbox chkCentr "Posunout na počátek objektu" offset:[0,3]
		label lb4 "Jinak dům stojí přesně na splinu" offset:[0,1]
		label lb5 "(objekt nech v počátku)." offset:[0,0]

		button btnNaMisto "Posadit objekt na spline" width:170 height:22 offset:[0,3]
		label lb6 "(vrátí objekt do počátku)" offset:[0,0]

		on btnRefresh pressed do
			for o in (selection as array) where (isKindOf o DumSplineGeo) do
				setProperty o #verze (o.verze + 1)

		on btnNaMisto pressed do
			for o in (selection as array) where (isKindOf o DumSplineGeo) do
			(
				o.transform = matrix3 1
				setProperty o #verze (o.verze + 1)
			)
	)

	rollout rMain "Rozměry"
	(
		spinner spPodlazi "Podlaží:" type:#integer range:[1,12,2] fieldwidth:58
		slider  slPodlazi "" type:#integer range:[1,12,2] ticks:0 width:150 offset:[0,-3]
		spinner spVyskaP "Výška podlaží (m):" type:#float range:[2,6,2.8] scale:0.05 fieldwidth:58
		spinner spTlSteny "Tloušťka stěn (m):" type:#float range:[0.1,1.2,0.4] scale:0.01 fieldwidth:58
		spinner spPodez "Podezdívka (m):" type:#float range:[0,2,0.45] scale:0.05 fieldwidth:58
		spinner spSoklP "Přesah soklu (m):" type:#float range:[0,0.5,0.06] scale:0.01 fieldwidth:58
		checkbox chkStropy "Stropní desky" checked:true

		on slPodlazi changed val do dumSplineSetParam #podlazi val
		on rMain open do try (slPodlazi.value = podlazi) catch ()
	)

	rollout rOkna "Okna a dveře"
	(
		spinner spRozpon "Rozteč oken (m):" type:#float range:[1.2,12,3.0] scale:0.1 fieldwidth:58
		spinner spOknoS "Šířka okna (m):" type:#float range:[0.4,5,1.5] scale:0.05 fieldwidth:58
		spinner spOknoV "Výška okna (m):" type:#float range:[0.4,3,1.4] scale:0.05 fieldwidth:58
		spinner spParapet "Parapet (m):" type:#float range:[0,2,0.9] scale:0.05 fieldwidth:58
		spinner spDeleni2 "Křídel v okně:" type:#integer range:[1,4,2] fieldwidth:58
		checkbox chkRamy "Rámy" checked:true
		checkbox chkParapet "Parapetní plechy" checked:true
		spinner spZapust "Zapuštění okna (m):" type:#float range:[0,0.6,0.16] scale:0.01 fieldwidth:58
		spinner spOdstup "Odstup od rohu (m):" type:#float range:[0.2,4,0.8] scale:0.05 fieldwidth:58
	)

	rollout rDvere "Vstupní dveře"
	(
		checkbox chkDvere "Vstupní dveře" checked:true
		spinner spDverS "Šířka dveří (m):" type:#float range:[0.7,3,1.2] scale:0.05 fieldwidth:58
		spinner spDverV "Výška dveří (m):" type:#float range:[1.8,3,2.1] scale:0.05 fieldwidth:58

		label lbR "— Kde budou dveře —" offset:[0,6]
		dropdownlist ddlRezim "" width:160 selection:1 \
			items:#("automaticky (nejdelší stěna)", "podle čísla úseku", \
					"podle světové strany", "podle pomocných bodů")

		label lbU "Číslo úseku a pozice na něm:" offset:[0,5]
		spinner spUsek "Úsek č.:" type:#integer range:[1,200,1] fieldwidth:58
		spinner spPozice "Pozice na úseku (0-1):" type:#float range:[0,1,0.5] scale:0.05 fieldwidth:58
		slider  slPozice "" type:#float range:[0,1,0.5] ticks:0 width:150 offset:[0,-3]
		button btnUseky "Vypsat úseky do Listeneru" width:170 height:22

		label lbS "Azimut, kam mají dveře koukat:" offset:[0,6]
		spinner spSmer2 "Směr (°):" type:#float range:[0,360,180] scale:5 fieldwidth:58

		label lbB "Značky dveří (každá = jeden vchod):" offset:[0,6]
		pickbutton btnPridat "+ Přidat značku" width:170 height:24
		listbox lbxZnacky "" items:#() height:5 width:170
		button btnOdebrat "Odebrat vybranou" width:170 height:20
		button btnVycistit "Vyčistit seznam" width:170 height:20
		label lbB2 "Point helper = jeden vchod," offset:[0,2]
		label lbB3 "spline = vchod v každém vrcholu." offset:[0,0]

		on slPozice changed val do dumSplineSetParam #dverPozice val
		on rDvere open do
			try ( slPozice.value = dverPozice; lbxZnacky.items = dumSplineJmenaZnacek() )
			catch ()

		on btnPridat picked obj do
		(
			if obj != undefined do
				for o in (selection as array) where (isKindOf o DumSplineGeo) do
					try ( append o.dverZnacky obj; setProperty o #verze (o.verze + 1) )
					catch ( format "Značku se nepodařilo přidat: %\n" (getCurrentException()) )
			try ( lbxZnacky.items = dumSplineJmenaZnacek() ) catch ()
		)

		on btnOdebrat pressed do
		(
			local i = lbxZnacky.selection
			if i > 0 do
				for o in (selection as array) where (isKindOf o DumSplineGeo) do
					try
					(
						if i <= o.dverZnacky.count do
						(
							deleteItem o.dverZnacky i
							setProperty o #verze (o.verze + 1)
						)
					)
					catch ( format "Značku se nepodařilo odebrat: %\n" (getCurrentException()) )
			try ( lbxZnacky.items = dumSplineJmenaZnacek() ) catch ()
		)

		on btnVycistit pressed do
		(
			for o in (selection as array) where (isKindOf o DumSplineGeo) do
				try
				(
					while o.dverZnacky.count > 0 do deleteItem o.dverZnacky o.dverZnacky.count
					setProperty o #verze (o.verze + 1)
				)
				catch ( format "Seznam se nepodařilo vyčistit: %\n" (getCurrentException()) )
			try ( lbxZnacky.items = dumSplineJmenaZnacek() ) catch ()
		)

		on btnUseky pressed do
			for o in (selection as array) where (isKindOf o DumSplineGeo) do
				if o.pudorys != undefined do
					try
					(
						local ob = bud_uklidObrys (bud_obrysZeSpline o.pudorys 1 (amax 1 o.deleni)) 0.01
						bud_vypisUseky ob
					)
					catch ( format "Půdorys se nepodařilo přečíst.\n" )
	)

	rollout rStrecha "Střecha"
	(
		dropdownlist ddlTyp "" width:160 selection:1 items:#("plochá s atikou", "pultová")
		label lbS "Na obecný tvar jde jen plochá" offset:[0,1]
		label lbS2 "nebo jednospádová." offset:[0,0]
		spinner spPresah "Přesah (m):" type:#float range:[0,2,0.5] scale:0.05 fieldwidth:58
		spinner spKrytTl "Tloušťka desky (m):" type:#float range:[0.05,1,0.3] scale:0.01 fieldwidth:58
		spinner spAtika "Výška atiky (m):" type:#float range:[0,2,0.5] scale:0.05 fieldwidth:58
		spinner spAtikaT "Tloušťka atiky (m):" type:#float range:[0.05,1,0.25] scale:0.01 fieldwidth:58
		spinner spSklon "Sklon (°):" type:#float range:[1,45,12] scale:1 fieldwidth:58
		spinner spSmer "Směr spádu (°):" type:#float range:[0,360,0] scale:5 fieldwidth:58
	)

	rollout rMat "Materiál a mapování"
	(
		checkbox chkMapovani "Generovat UV mapování" checked:true
		spinner spUV "Velikost dlaždice UV (m):" type:#float range:[0.05,20,1.0] scale:0.1 fieldwidth:58
		spinner spJednotky "1 m = ... jednotek:" type:#float range:[0.0001,10000,1.0] scale:1 fieldwidth:58
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

		/*--- obrys ---*/
		local obrys = #()
		if pudorys != undefined do
			try
			(
				if (superclassof pudorys) == shape do
					obrys = bud_uklidObrys (bud_obrysZeSpline pudorys 1 (amax 1 deleni)) (0.01 * U)
			)
			catch ( obrys = #() )

		if obrys.count < 3 then
		(
			-- bez platného splinu postavíme jen značku, ať je objekt vidět
			pnl_addBox cx (-1.0 * U) (-1.0 * U) 0 (1.0 * U) (1.0 * U) (0.2 * U) PNL_MAT_SOKL uv
		)
		else
		(
			-- volitelné posunutí na počátek objektu
			if vycentrovat do
			(
				local sx = 0.0
				local sy = 0.0
				for p in obrys do ( sx = sx + p.x; sy = sy + p.y )
				sx = sx / obrys.count
				sy = sy / obrys.count
				local posun = #()
				for p in obrys do append posun [ p.x - sx, p.y - sy, p.z ]
				obrys = posun
			)

			local np = obrys.count
			local NF = amax 1 podlazi
			local fh = amax (2.0 * U) (vyskaPodlazi * U)
			local t  = amax (0.1 * U) (tlSteny * U)
			local zb = amax 0.0 (podezdivka * U)
			local so = amax 0.0 (soklPresah * U)
			local ze = zb + NF * fh

			local oh = amin (amax (0.3 * U) (oknoVyska * U)) (fh - 0.4 * U)
			local ow = amax (0.3 * U) (oknoSirka * U)
			local par = amax 0.0 (amin (parapet * U) (fh - oh - 0.25 * U))
			local rozt = amax (1.0 * U) (rozponOsy * U)
			local odst = amax (0.2 * U) (odstupRohu * U)
			local dw = amax (0.6 * U) (dverSirka * U)
			local dh = amin (dverVyska * U) (fh - 0.25 * U)

			local fw = 0.07 * U
			local ins = amin (amax 0.0 (sklozap * U)) (t - fw * 1.2)
			if ins < 0.0 do ins = 0.0

			local det = pnl_det()
			det.U = U
			det.ramy = ramy
			det.ram = fw
			det.zapusteni = ins
			det.deleni = amax 1 oknoDeleni
			det.nadsvetlik = false
			det.parapetPlech = parapetPlech
			det.parapetTl = 0.04 * U
			det.parapetPresah = 0.06 * U
			det.dverKridla = 2

			-- vnitřní líc stěn jako zkosený obrys: díky němu rohy doléhají
			local obrysIn = bud_odsazObrys obrys (-t)

			/*--- kam přijdou dveře --------------------------------------------
				dvereNa[k] je seznam vzdáleností podél úseku k, kde mají být
				dveře. Podle zvoleného režimu se naplní různě.             */
			local dvereNa = for k = 1 to np collect #()
			if dvere do
			(
				case dverRezim of
				(
					2: (
						local ui = amax 1 (amin dverUsek np)
						local m = ((mod ui np) as integer) + 1
						local dl = distance obrys[ui] obrys[m]
						append dvereNa[ui] (dl * (amax 0.0 (amin dverPozice 1.0)))
					)
					3: (
						local ui = bud_usekPodleSmeru obrys dverSmer
						local m = ((mod ui np) as integer) + 1
						append dvereNa[ui] ((distance obrys[ui] obrys[m]) * 0.5)
					)
					4: (
						for nd in dverZnacky do
							if (isValidNode nd) do
								for b in (bud_bodyZUzlu nd) do
								(
									local nal = bud_najdiNaObrysu obrys b
									append dvereNa[nal[1]] nal[2]
								)
					)
					default: (
						local idv = 1
						local nejdel = 0.0
						for k = 1 to np do
						(
							local m = ((mod k np) as integer) + 1
							local dl = distance obrys[k] obrys[m]
							if dl > nejdel do ( nejdel = dl; idv = k )
						)
						append dvereNa[idv] (nejdel * 0.5)
					)
				)
			)

			/*--- stěny po jednotlivých úsecích obrysu ---*/
			for k = 1 to np do
			(
				local m = ((mod k np) as integer) + 1
				local pa = obrys[k]
				local pb = obrys[m]
				local vek = [ pb.x - pa.x, pb.y - pa.y, 0 ]
				local dl = length vek
				if dl > 0.05 * U do
				(
					local dv = vek / dl
					-- vnější normála je vpravo od směru (obrys je proti směru
					-- hodinových ručiček), dovnitř tedy doleva
					local nv = [ -dv.y, dv.x, 0 ]
					local org = [ pa.x, pa.y, 0 ]

					/*--- otvory na tomhle úseku ---*/
					local ops = #()
					local knd = #()
					local volno = dl - 2 * odst
					if volno > ow do
					(
						local nok = amax 1 ((floor (volno / rozt + 0.5)) as integer)
						local krok = volno / nok
						local ow2 = amin ow (krok - 0.4 * U)
						if ow2 > 0.3 * U do
							for f = 1 to NF do
							(
								local zf = zb + (f - 1) * fh
								for i = 1 to nok do
								(
									local ac = odst + krok * (i - 0.5)
									append ops [ ac - ow2 * 0.5, ac + ow2 * 0.5, zf + par, zf + par + oh ]
									append knd 1
								)
							)
					)
					/*--- vstupní dveře na tomhle úseku ---*/
					for ad0 in dvereNa[k] do
						if dl > dw + 0.6 * U do
						(
							-- ať se dveře vejdou celé i s kouskem zdi u rohu
							local ad = amax (dw * 0.5 + 0.25 * U) (amin ad0 (dl - dw * 0.5 - 0.25 * U))
							-- okna v přízemí, co by kolidovala, zahodíme
							local o2 = #()
							local k2 = #()
							for j = 1 to ops.count do
							(
								local o = ops[j]
								local drop = (knd[j] != 3 and o.z < zb + dh \
											  and o.x < ad + dw * 0.5 + 0.3 * U \
											  and o.y > ad - dw * 0.5 - 0.3 * U)
								if not drop do ( append o2 o; append k2 knd[j] )
							)
							ops = o2
							knd = k2
							append ops [ ad - dw * 0.5, ad + dw * 0.5, zb, zb + dh ]
							append knd 3
						)

					/*--- stěna s otvory ---*/
					local qa = obrysIn[k]
					local qb2 = obrysIn[m]
					local R = pnl_wallRects 0.0 dl zb ze ops
					for r in R do
						bud_stenaKus cx org dv qa qb2 dl r.x r.y r.z r.w PNL_MAT_FASADA uv
					for j = 1 to ops.count do
						bud_vyplnSeg cx org dv nv ops[j] knd[j] det PNL_MAT_SKLO uv
				)
			)

			/*--- podlahy a stropy ---*/
			local plocha = #()
			for p in obrys do append plocha [ p.x, p.y, 0 ]
			if stropy do
				for f = 1 to NF do
				(
					local zf = zb + f * fh
					local zdol = for k = 1 to np collect (zf - 0.25 * U)
					local zhor = for k = 1 to np collect zf
					bud_extrudeVar cx plocha zdol zhor PNL_MAT_DESKA uv
				)
			/*	Podezdívka je jeden kus podle obrysu rozšířeného o přesah, ne
				kvádry po úsecích - ty se v rozích překrývaly a trčely ven.  */
			local obrysSokl = if so > 1e-5 then (bud_odsazObrys obrys so) else plocha
			local zd0 = for k = 1 to np collect (-0.3 * U)
			local zh0 = for k = 1 to np collect (amax (0.05 * U) zb)
			bud_extrudeVar cx obrysSokl zd0 zh0 PNL_MAT_SOKL uv

			/*--- střecha ---*/
			local ktl = amax (0.04 * U) (krytinaTl * U)
			local pres = amax 0.0 (presah * U)
			local obrysS = if pres > 1e-5 then (bud_odsazObrys obrys pres) else plocha

			if typStrechy == 2 then
			(
				-- pultová: rovina nakloněná v zadaném směru
				local uhel = smerSpadu
				local sx2 = cos uhel
				local sy2 = sin uhel
				local tg = tan (amax 1.0 (amin sklon 60.0))
				local dmin = 1e9
				for p in obrysS do
				(
					local pr = p.x * sx2 + p.y * sy2
					if pr < dmin do dmin = pr
				)
				local zdolS = #()
				local zhorS = #()
				for p in obrysS do
				(
					local pr = p.x * sx2 + p.y * sy2
					local zz = ze + (pr - dmin) * tg
					append zdolS zz
					append zhorS (zz + ktl)
				)
				bud_extrudeVar cx obrysS zdolS zhorS BUD_MAT_KRYTINA uv
				-- dozdívka stěn pod šikmou rovinu
				for k = 1 to np do
				(
					local m = ((mod k np) as integer) + 1
					local pa = obrys[k]
					local pb = obrys[m]
					local vek = [ pb.x - pa.x, pb.y - pa.y, 0 ]
					local dl = length vek
					if dl > 0.05 * U do
					(
						local dv = vek / dl
						local nv = [ -dv.y, dv.x, 0 ]
						local org = [ pa.x, pa.y, 0 ]
						local za2 = ze + ((pa.x * sx2 + pa.y * sy2) - dmin) * tg
						local zb2 = ze + ((pb.x * sx2 + pb.y * sy2) - dmin) * tg
						local zmax = amax za2 zb2
						if zmax > ze + 1e-4 do
							bud_addBoxLoc cx org dv nv 0.0 0.0 ze dl t zmax PNL_MAT_FASADA uv
					)
				)
			)
			else
			(
				-- plochá s atikou
				local zdolS = for k = 1 to np collect ze
				local zhorS = for k = 1 to np collect (ze + ktl)
				bud_extrudeVar cx obrysS zdolS zhorS PNL_MAT_STRECHA uv
				local av = amax 0.0 (atikaVyska * U)
				if av > 0.02 * U do
				(
					-- atika i oplechování jako prstenec mezi dvěma zkosenými
					-- obrysy, takže v rozích i u zářezů navazuje bez zlomů
					local atk = amax (0.05 * U) (atikaTl * U)
					local za2 = ze + ktl
					local atIn = bud_odsazObrys obrysS (-atk)
					bud_prstenec cx obrysS atIn za2 (za2 + av) PNL_MAT_STRECHA uv
					local opVen = bud_odsazObrys obrysS (0.06 * U)
					local opDo = bud_odsazObrys obrysS (-(atk + 0.06 * U))
					bud_prstenec cx opVen opDo (za2 + av) (za2 + av + 0.05 * U) PNL_MAT_KLEMP uv
				)
			)
		)

		/*--- sestavení meshe ---*/
		if cx.V.count < 3 do pnl_addBox cx (-U) (-U) 0 U U (0.2 * U) PNL_MAT_FASADA uv
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

/*--- jména značek dveří prvního vybraného domu (pro seznam v rollupu) ------*/
fn dumSplineJmenaZnacek =
(
	local jm = #()
	local prvni = undefined
	for o in (selection as array) where (isKindOf o DumSplineGeo) do
		if prvni == undefined do prvni = o
	if prvni != undefined do
		try
		(
			for n in prvni.dverZnacky do
				if (isValidNode n) then append jm n.name
				else append jm "<smazaný objekt>"
		)
		catch ()
	jm
)

fn dumSplineSetParam pname val =
(
	for o in (selection as array) where (isKindOf o DumSplineGeo) do setProperty o pname val
	ok
)

macroScript DumSplineCreate
	category:"Budovy"
	buttonText:"Dum podle pudorysu"
	tooltip:"Vytvorit dum podle nakresleneho splinu"
(
	on execute do
	(
		local dnode = DumSplineGeo name:(uniquename "DumPudorys")
		dnode.pos = [0, 0, 0]
		select dnode
		max modify mode
	)
)

format "\nDům podle půdorysu: plugin načten. Create > Geometry > kategorie \"Budovy\".\n"
