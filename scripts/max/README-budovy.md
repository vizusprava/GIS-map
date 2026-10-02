# Generátory budov pro 3ds Max

Čtyři další typy budov postavené na stejném principu jako panelák (viz
[README.md](README.md)): scripted pluginy, parametry se mění kdykoliv v Modify
panelu, model se přepočítá okamžitě.

| soubor | typ | k čemu |
|--------|-----|--------|
| `dum-rodinny.ms` | **Rodinný dům** | klasický dům, 5 typů střechy, garáž |
| `dum-mestsky.ms` | **Městský dům** | činžák do ulice: obchody dole, byty nahoře |
| `dum-vyskovy.ms` | **Výšková budova** | velkoměstská věž s podnoží a ustupováním |
| `dum-moderni.ms` | **Moderní bytový dům** | novostavba s lodžiemi a parterem |
| `dum-spline.ms` | **Dům podle půdorysu** | atypický tvar podle nakresleného splinu |
| `budovy-lib.ms` | *(knihovna)* | sdílené funkce — šikmé plochy, hranoly, střechy |

## Instalace

Všechny soubory musí ležet v jedné složce spolu s `panelak.ms` — z něj berou
základní stavebnici (kvádr, trubka, stěna s otvory, výplně oken a dveří,
materiál). Spustit stačí ten generátor, který chceš; knihovnu i `panelak.ms` si
natáhne sám.

Objekty najdeš v **Create → Geometry → kategorie „Budovy"**, vytvoří se jedním
kliknutím do pohledu. Rozměry se zadávají v metrech (přepínač jednotek je
v posledním rollupu, stejně jako u paneláku).

Materiál je **společný se paneláky** — stejné tlačítko, stejná ID, plus dva
nové sloty: **24 krytina** a **25 římsy a šambrány**. Sklo se vytvoří jako
VRayMtl, pokud je V-Ray k dispozici.

## Rodinný dům

1–4 podlaží, podezdívka, okna po zadané rozteči na všech čtyřech stranách,
vstupní dveře uprostřed uliční fasády se stříškou na trubkových sloupcích.

**Pět typů střechy:** plochá s atikou, sedlová, valbová, pultová, stanová.
Sklon, přesah a tloušťka krytiny jsou parametry. U sedlové a pultové se
automaticky dostaví štítové stěny do tvaru střechy. Volitelně komín.

**Garáž** se přistaví z boku jako samostatný objem, čelem v jedné rovině s domem.
Dá se nastavit skoro všechno:

- strana (vpravo / vlevo), šířka, hloubka, výška
- **1 až 3 vrata** vedle sebe, se šířkou a výškou — vrata jsou sekční, s
  vodorovnými panely
- **vedlejší dveře** vedle vrat (přeskočí se, kdyby kolidovaly s vraty)
- **okénko** v boční stěně
- **vlastní typ střechy**: plochá, pultová, sedlová nebo valbová, s vlastním
  sklonem a přesahem — nezávisle na střeše domu

Na návaznost garáže na dům se hlídají tři věci:

- ve **štítové stěně domu se vynechají okna**, která garáž zakrývá — podle
  půdorysu i podle výšky, takže okna nad garáží zůstanou
- **přesah garážové střechy** se na straně u domu zkrátí, aby okap skončil
  přesně v líci domu a nezajížděl do zdi
- **výška garáže** se ořízne na úroveň okapu domu, aby přístavek neprošel skrz
  stěnu do obytného podlaží

## Městský dům

Tohle je ten typ, co má **dole obchody a nahoře byty**.

**Parter** je vysoký samostatně (výchozí 4,2 m), rozdělený pilíři na zadaný počet
obchodů s velkými výlohami, plus vchod do domu. Volitelně markýzy nad výlohami
a jiný materiál obkladu než na zbytku domu.

**Bytová podlaží** mají okna s nadsvětlíkem a volitelně **šambrány** (rámování
kolem oken). Na každé N-té ose může být **francouzské okno** s trubkovým
zábradlíčkem — okno sahá až k podlaze.

**Římsy:** kordonová nad parterem (odděluje obchody od bytů) a hlavní pod
střechou. Střecha plochá s atikou, sedlová nebo valbová.

## Výšková budova

Podnož (podium) s prosklenou vstupní halou může přesahovat půdorys věže; nad ní
věž, která se po zadaném počtu podlaží **ustupuje** dovnitř — z toho vznikne
stupňovitá silueta typická pro mrakodrapy.

**Tři typy fasády:** pásová okna (souvislý pás skla po obvodu), rastr
jednotlivých oken, nebo celoprosklená. K tomu svislé sloupky, mezipásy v úrovni
stropů a zvýrazněné rohové pilíře.

Na střeše technologie a stožár. Rozsvícená okna fungují stejně jako u paneláku.

## Moderní bytový dům

Novostavba: plochá střecha, velká okna, volitelný **obchodní parter** v přízemí
s výraznou deskou nad ním.

**Lodžie** buď zapuštěné do hmoty (se stropem, boky a dělicími stěnami), nebo
vystouplé jako balkony. Zábradlí skleněné (tabule s trubkovým madlem) nebo
trubkové. Lodžie sedí na osách a mají balkonové dveře, stejně jako u paneláku.

**Ustoupené poslední podlaží** posune přední stěnu dozadu a z uvolněného místa
udělá terasu se zábradlím — u novostaveb obvyklé.

## Dům podle půdorysu

Pro atypické tvary — do L, do U, se zkosenými rohy, prostě cokoliv.

1. Nakresli **uzavřený spline** v půdorysu (Create → Shapes → Line).
2. Vytvoř objekt **Dům podle půdorysu** (vznikne v počátku, viz níž).
3. V rollupu *Půdorys* ho tlačítkem vyber.

Dům se po obrysu obtáhne stěnami, rozmístí okna po zadané rozteči do každého
úseku (s odstupem od rohů, aby nevycházela hned u nároží) a nasadí střechu.

### Kde budou dveře

Rollup *Vstupní dveře* nabízí čtyři způsoby:

| režim | jak to funguje |
|-------|----------------|
| **automaticky** | doprostřed nejdelší stěny — rychlé, když je ti to jedno |
| **podle čísla úseku** | zadáš číslo úseku obrysu a pozici na něm (0 = začátek, 1 = konec) |
| **podle světové strany** | zadáš azimut a dveře přijdou do stěny, která tím směrem kouká — dobré, když víš, kde je ulice |
| **podle pomocných bodů** | postavíš si značky a každá z nich udělá jeden vchod |

U režimu *podle čísla úseku* pomůže tlačítko **„Vypsat úseky do Listeneru"** —
vypíše pro každý úsek jeho číslo, délku, střed a azimut vnější normály, takže
z toho poznáš, který je který (a rovnou i azimut pro třetí režim).

Režim *podle pomocných bodů* je nejpohodlnější na ladění a zvládne **libovolný
počet vchodů**. Značky se přidávají do seznamu tlačítkem **„+ Přidat značku"**
(vybereš objekt v pohledu), jednotlivě se dají odebírat nebo seznam vyčistit.

- **Point helper** = jeden vchod; táhneš s ním a dveře jdou za ním
- **spline** = vchod v **každém jeho vrcholu**, takže jedním objektem zadáš
  rovnou celou skupinu

Dveře se vždycky posunou tak, aby se vešly celé a nezasahovaly do rohu; okna,
která by s nimi kolidovala, se vynechají. Smazanou značku seznam pozná a označí
ji jako `<smazaný objekt>`.

Po přesunu značky zmáčkni *Přepočítat podle splinu* — Max mezi objektem a
značkami nedrží závislost.

**Souřadnice:** dům se staví ve světových souřadnicích splinu, takže objekt nech
v počátku — pak stojí přesně na splinu. Zaškrtávátko *Posunout na počátek
objektu* ho místo toho vycentruje na vlastní pivot.

**Když spline upravíš**, zmáčkni *Přepočítat podle splinu* — Max mezi objektem
a splinem nedrží závislost, takže se to samo nepřekreslí.

**Dělení oblouků:** 1 = použijí se přímo vrcholy splinu (přesné pro lomenou
čáru), víc = spline se navzorkuje, což je potřeba u oblouků.

**Střecha** může být plochá s atikou nebo jednospádová (sklon i směr spádu jsou
parametry). Sedlová a valbová tu nejsou — na obecný tvar je nelze odvodit bez
konstrukce střešní osnovy, na to je `dum-rodinny.ms` s obdélníkovým půdorysem.

## Poznámka k rychlosti

Platí totéž co u paneláku: výšková budova s 40 podlažími a rastrem oken má
desítky tisíc polygonů. Při ladění proporcí si sniž počet podlaží nebo vypni
sloupky a mezipásy, na konci zapni zpátky.
