-- ════════════════════════════════════════════════════════════════════════════════
-- Geo Studio — sdílení scén s kolegy
--
-- Spustit v SQL editoru Supabase (Dashboard → SQL Editor → New query → vložit → Run),
-- až po 001_init.sql a 002_account.sql. Skript je idempotentní, opakované spuštění nic
-- nerozbije.
--
-- Model: scéna má pořád JEDNOHO vlastníka (`geo_scenes.owner`). Ten ji může nasdílet dalším
-- lidem jako
--   • viewer — vidí scénu i soubory, nic neuloží,
--   • editor — smí měnit stav scény a nahrávat / mazat soubory; smazat ani nasdílet ji nesmí.
--
-- Všechno ve scéně patří jejímu vlastníkovi, i to, co nahrál editor: řádek v `geo_assets` má
-- `owner` = vlastník scény a binárka leží v jeho složce (`{vlastník}/{scéna}/…`). Když pak
-- editor smaže svůj účet, scéně nic nezmizí, a místo v úložišti se počítá tomu, komu scéna patří.
--
-- Pozvat jde i e-mail, který ještě nemá účet: pozvánka počká a po registraci (potvrzení
-- e-mailu) se z ní sama stane členství.
-- ════════════════════════════════════════════════════════════════════════════════

-- ── 1) Členové a pozvánky ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.geo_scene_members (
  scene_id   uuid NOT NULL REFERENCES public.geo_scenes(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('viewer', 'editor')),
  invited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- kdy scénu tenhle člen naposledy otevřel (přehled řadí podle „naposledy otevřené"
  -- a sdílená scéna nesmí přeskakovat ostatním jen proto, že ji otevřel někdo jiný)
  opened_at  timestamptz,
  PRIMARY KEY (scene_id, user_id)
);

CREATE INDEX IF NOT EXISTS geo_scene_members_user_idx ON public.geo_scene_members(user_id);

CREATE TABLE IF NOT EXISTS public.geo_scene_invites (
  scene_id   uuid NOT NULL REFERENCES public.geo_scenes(id) ON DELETE CASCADE,
  -- vždy malými písmeny (viz share_scene)
  email      text NOT NULL,
  role       text NOT NULL CHECK (role IN ('viewer', 'editor')),
  invited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scene_id, email)
);

CREATE INDEX IF NOT EXISTS geo_scene_invites_email_idx ON public.geo_scene_invites(email);

-- ── 2) Pomocné funkce pro RLS ──────────────────────────────────────────────────────
-- Běží s právy vlastníka (SECURITY DEFINER): kdyby se pravidlo pro geo_scenes ptalo na členy
-- a pravidlo pro členy na geo_scenes, RLS by se zacyklilo. Vrací jen to, co se týká
-- přihlášeného uživatele (`auth.uid()`), nic o cizích scénách.

-- Moje role ve scéně: 'owner' | 'editor' | 'viewer' | NULL (žádný přístup / scéna neexistuje).
CREATE OR REPLACE FUNCTION public.geo_scene_role(p_scene uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN s.owner = auth.uid() THEN 'owner'
    ELSE (SELECT m.role FROM public.geo_scene_members m WHERE m.scene_id = s.id AND m.user_id = auth.uid())
  END
  FROM public.geo_scenes s
  WHERE s.id = p_scene
$$;

-- Smím ve scéně zapisovat soubor patřící `p_owner`? (vlastník nebo editor, a soubor musí
-- patřit vlastníkovi scény — nikdo si nesmí „přivlastnit" soubor v cizí scéně.)
CREATE OR REPLACE FUNCTION public.geo_can_write_asset(p_scene uuid, p_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.geo_scenes s
    WHERE s.id = p_scene
      AND s.owner = p_owner
      AND (s.owner = auth.uid() OR EXISTS (
        SELECT 1 FROM public.geo_scene_members m
        WHERE m.scene_id = s.id AND m.user_id = auth.uid() AND m.role = 'editor'))
  )
$$;

-- Přístup k souboru v bucketu podle cesty `{vlastník}/{scéna}/…`. Čtení stačí kterýkoliv člen,
-- zápis/mazání jen editor. Vlastní složku (`{já}/…`) řeší dál původní pravidla z 001.
CREATE OR REPLACE FUNCTION public.geo_storage_access(p_name text, p_write boolean)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  f text[] := storage.foldername(p_name);
  s uuid;
  o uuid;
BEGIN
  -- druhá složka musí být id scény (např. `{uid}/textures/…` není scéna — a přetypování
  -- čehokoliv jiného na uuid by spadlo s chybou místo prostého „ne")
  IF coalesce(array_length(f, 1), 0) < 2
     OR f[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  s := f[2]::uuid;
  SELECT owner INTO o FROM public.geo_scenes WHERE id = s;
  IF o IS NULL OR o::text <> f[1] THEN
    RETURN false;
  END IF;
  IF o = auth.uid() THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.geo_scene_members m
    WHERE m.scene_id = s AND m.user_id = auth.uid() AND (NOT p_write OR m.role = 'editor')
  );
END;
$$;

-- Sdílím s tímhle člověkem nějakou scénu? (Jen pak smím vidět jeho jméno a e-mail.)
CREATE OR REPLACE FUNCTION public.geo_shares_with(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    -- on je členem mojí scény / já jsem členem jeho scény
    SELECT 1 FROM public.geo_scene_members m JOIN public.geo_scenes s ON s.id = m.scene_id
    WHERE (s.owner = auth.uid() AND m.user_id = p_user)
       OR (s.owner = p_user AND m.user_id = auth.uid())
  ) OR EXISTS (
    -- oba jsme členy téže scény
    SELECT 1 FROM public.geo_scene_members a JOIN public.geo_scene_members b ON a.scene_id = b.scene_id
    WHERE a.user_id = auth.uid() AND b.user_id = p_user
  )
$$;

-- Pomocné funkce z REST API volat nejde (jsou jen pro pravidla); geo_scene_role ano —
-- appka se jím ptá na roli při otevření scény.
REVOKE ALL ON FUNCTION public.geo_scene_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.geo_scene_role(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.geo_can_write_asset(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.geo_can_write_asset(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.geo_storage_access(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.geo_storage_access(text, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.geo_shares_with(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.geo_shares_with(uuid) TO authenticated;

-- ── 3) RLS: scény ──────────────────────────────────────────────────────────────────
-- Vlastník má dál všechno (geo_scenes_owner_all z 001). Navíc: člen scénu vidí, editor ji
-- smí měnit (stav, název, náhled). Smazat ji smí jen vlastník.
DROP POLICY IF EXISTS geo_scenes_member_select ON public.geo_scenes;
CREATE POLICY geo_scenes_member_select ON public.geo_scenes
  FOR SELECT TO authenticated
  USING (public.geo_scene_role(id) IN ('editor', 'viewer'));

DROP POLICY IF EXISTS geo_scenes_editor_update ON public.geo_scenes;
CREATE POLICY geo_scenes_editor_update ON public.geo_scenes
  FOR UPDATE TO authenticated
  USING (public.geo_scene_role(id) = 'editor')
  WITH CHECK (public.geo_scene_role(id) = 'editor');

-- Vlastnictví scény se nepřevádí — ani editor si ji nesmí „přepsat" na sebe.
CREATE OR REPLACE FUNCTION public.geo_scenes_keep_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.owner IS DISTINCT FROM OLD.owner THEN
    RAISE EXCEPTION 'Vlastníka scény nejde změnit';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.geo_scenes_keep_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS geo_scenes_keep_owner ON public.geo_scenes;
CREATE TRIGGER geo_scenes_keep_owner
  BEFORE UPDATE OF owner ON public.geo_scenes
  FOR EACH ROW EXECUTE FUNCTION public.geo_scenes_keep_owner();

-- ── 4) RLS: soubory scény ──────────────────────────────────────────────────────────
-- Místo obecného „owner = já" (001) se přístup řídí rolí ve scéně. Zároveň se tím zavírá
-- díra z 001, kdy šlo vložit vlastní řádek do cizí scény, pokud člověk znal její id.
DROP POLICY IF EXISTS geo_assets_owner_all ON public.geo_assets;

DROP POLICY IF EXISTS geo_assets_select ON public.geo_assets;
CREATE POLICY geo_assets_select ON public.geo_assets
  FOR SELECT TO authenticated
  USING (public.geo_scene_role(scene_id) IS NOT NULL);

DROP POLICY IF EXISTS geo_assets_insert ON public.geo_assets;
CREATE POLICY geo_assets_insert ON public.geo_assets
  FOR INSERT TO authenticated
  WITH CHECK (public.geo_can_write_asset(scene_id, owner));

DROP POLICY IF EXISTS geo_assets_update ON public.geo_assets;
CREATE POLICY geo_assets_update ON public.geo_assets
  FOR UPDATE TO authenticated
  USING (public.geo_scene_role(scene_id) IN ('owner', 'editor'))
  WITH CHECK (public.geo_can_write_asset(scene_id, owner));

DROP POLICY IF EXISTS geo_assets_delete ON public.geo_assets;
CREATE POLICY geo_assets_delete ON public.geo_assets
  FOR DELETE TO authenticated
  USING (public.geo_scene_role(scene_id) IN ('owner', 'editor'));

-- ── 5) RLS: členové a pozvánky ─────────────────────────────────────────────────────
ALTER TABLE public.geo_scene_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geo_scene_invites ENABLE ROW LEVEL SECURITY;

-- Seznam lidí ve scéně vidí každý, kdo v ní je. Přidává se jen přes share_scene().
DROP POLICY IF EXISTS geo_scene_members_select ON public.geo_scene_members;
CREATE POLICY geo_scene_members_select ON public.geo_scene_members
  FOR SELECT TO authenticated
  USING (public.geo_scene_role(scene_id) IS NOT NULL);

-- Roli mění jen vlastník scény.
DROP POLICY IF EXISTS geo_scene_members_update ON public.geo_scene_members;
CREATE POLICY geo_scene_members_update ON public.geo_scene_members
  FOR UPDATE TO authenticated
  USING (public.geo_scene_role(scene_id) = 'owner')
  WITH CHECK (public.geo_scene_role(scene_id) = 'owner');

-- Odebrat člena smí vlastník; člen sám sebe (= „opustit scénu").
DROP POLICY IF EXISTS geo_scene_members_delete ON public.geo_scene_members;
CREATE POLICY geo_scene_members_delete ON public.geo_scene_members
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.geo_scene_role(scene_id) = 'owner');

-- Čekající pozvánky vidí a ruší jen vlastník scény. Vznikají jen přes share_scene().
DROP POLICY IF EXISTS geo_scene_invites_select ON public.geo_scene_invites;
CREATE POLICY geo_scene_invites_select ON public.geo_scene_invites
  FOR SELECT TO authenticated
  USING (public.geo_scene_role(scene_id) = 'owner');

DROP POLICY IF EXISTS geo_scene_invites_update ON public.geo_scene_invites;
CREATE POLICY geo_scene_invites_update ON public.geo_scene_invites
  FOR UPDATE TO authenticated
  USING (public.geo_scene_role(scene_id) = 'owner')
  WITH CHECK (public.geo_scene_role(scene_id) = 'owner');

DROP POLICY IF EXISTS geo_scene_invites_delete ON public.geo_scene_invites;
CREATE POLICY geo_scene_invites_delete ON public.geo_scene_invites
  FOR DELETE TO authenticated
  USING (public.geo_scene_role(scene_id) = 'owner');

-- Jméno a e-mail lidí, se kterými sdílím scénu (seznam členů, „sdílí: Jana").
DROP POLICY IF EXISTS profiles_shared_select ON public.profiles;
CREATE POLICY profiles_shared_select ON public.profiles
  FOR SELECT TO authenticated
  USING (public.geo_shares_with(id));

-- ── 6) Storage: soubory sdílených scén ────────────────────────────────────────────
-- Původní pravidla geo_own_* (vlastní složka) zůstávají; tahle k nim přidávají sdílené scény.
DO $$
DECLARE op text;
BEGIN
  FOREACH op IN ARRAY ARRAY['select', 'insert', 'update', 'delete']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', 'geo_shared_' || op);
  END LOOP;
END $$;

CREATE POLICY geo_shared_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'geo' AND public.geo_storage_access(name, false));

CREATE POLICY geo_shared_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'geo' AND public.geo_storage_access(name, true));

CREATE POLICY geo_shared_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'geo' AND public.geo_storage_access(name, true))
  WITH CHECK (bucket_id = 'geo' AND public.geo_storage_access(name, true));

CREATE POLICY geo_shared_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'geo' AND public.geo_storage_access(name, true));

-- ── 7) Nasdílení scény ─────────────────────────────────────────────────────────────
-- Volá vlastník scény. Má-li e-mail potvrzený účet, člověk se rovnou přidá mezi členy
-- ('added'); jinak vznikne pozvánka, která počká na registraci ('invited'). Opakované
-- nasdílení stejnému člověku jen změní roli.
CREATE OR REPLACE FUNCTION public.share_scene(p_scene uuid, p_email text, p_role text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid := auth.uid();
  e text := lower(trim(p_email));
  target uuid;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Nejsi přihlášený';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.geo_scenes WHERE id = p_scene AND owner = me) THEN
    RAISE EXCEPTION 'Sdílet může jen vlastník scény';
  END IF;
  IF p_role NOT IN ('viewer', 'editor') THEN
    RAISE EXCEPTION 'Neznámá role %', p_role;
  END IF;
  IF e !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'Neplatná e-mailová adresa';
  END IF;

  SELECT u.id INTO target
  FROM auth.users u
  JOIN public.profiles p ON p.id = u.id
  WHERE lower(u.email) = e AND u.email_confirmed_at IS NOT NULL
  LIMIT 1;

  IF target = me THEN
    RAISE EXCEPTION 'Scéna už je tvoje';
  END IF;

  IF target IS NOT NULL THEN
    INSERT INTO public.geo_scene_members (scene_id, user_id, role, invited_by)
    VALUES (p_scene, target, p_role, me)
    ON CONFLICT (scene_id, user_id) DO UPDATE SET role = EXCLUDED.role;
    DELETE FROM public.geo_scene_invites WHERE scene_id = p_scene AND email = e;
    RETURN 'added';
  END IF;

  INSERT INTO public.geo_scene_invites (scene_id, email, role, invited_by)
  VALUES (p_scene, e, p_role, me)
  ON CONFLICT (scene_id, email) DO UPDATE SET role = EXCLUDED.role;
  RETURN 'invited';
END;
$$;

REVOKE ALL ON FUNCTION public.share_scene(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.share_scene(uuid, text, text) TO authenticated;

-- ── 8) Pozvánky se po registraci samy promění ve členství ─────────────────────────
-- Jen pro potvrzený e-mail: kdo si e-mail „vypůjčí" registrací bez potvrzení, k cizí scéně
-- se nedostane. Trigger se jmenuje tak, aby běžel PO on_auth_user_created (Postgres je
-- spouští podle abecedy), tedy až když profil existuje.
CREATE OR REPLACE FUNCTION public.claim_scene_invites()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.email IS NULL OR NEW.email_confirmed_at IS NULL THEN
    RETURN NEW;
  END IF;
  -- Registrace ani potvrzení e-mailu nesmí kvůli pozvánkám nikdy spadnout — případná chyba
  -- se jen zapíše do logu a pozvánka zůstane čekat.
  BEGIN
    INSERT INTO public.geo_scene_members (scene_id, user_id, role, invited_by)
    SELECT i.scene_id, NEW.id, i.role, i.invited_by
    FROM public.geo_scene_invites i
    JOIN public.geo_scenes s ON s.id = i.scene_id
    WHERE i.email = lower(NEW.email)
      AND s.owner <> NEW.id
      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.id)
    ON CONFLICT (scene_id, user_id) DO NOTHING;

    DELETE FROM public.geo_scene_invites i
    WHERE i.email = lower(NEW.email)
      AND EXISTS (SELECT 1 FROM public.geo_scene_members m WHERE m.scene_id = i.scene_id AND m.user_id = NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'claim_scene_invites: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_scene_invites() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_invites ON auth.users;
CREATE TRIGGER on_auth_user_invites
  AFTER INSERT OR UPDATE OF email, email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.claim_scene_invites();

-- ── 9) Ukládání stavu po částech ───────────────────────────────────────────────────
-- Stav scény je jeden JSON. Když ho ve sdílené scéně píšou dva lidi naráz celý, poslední
-- zápis smaže, co mezitím uložil ten druhý (třeba nový pohled kamery). Appka proto posílá
-- jen klíče, které se změnily, a databáze je vmíchá do uloženého stavu. Běží s právy
-- volajícího, takže pustí jen vlastníka a editora (RLS výš).
CREATE OR REPLACE FUNCTION public.patch_scene_state(p_scene uuid, p_patch jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Stav scény musí být objekt';
  END IF;
  UPDATE public.geo_scenes SET state = coalesce(state, '{}'::jsonb) || p_patch WHERE id = p_scene;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Scénu nejde uložit — neexistuje, nebo do ní nesmíš zapisovat';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.patch_scene_state(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.patch_scene_state(uuid, jsonb) TO authenticated;

-- ── 10) „Naposledy otevřeno" i pro sdílené scény ──────────────────────────────────
-- Vlastník si zapisuje do geo_scenes.opened_at, člen do svého řádku v geo_scene_members.
-- Přímý UPDATE členství by členovi dovolil změnit si i roli, proto přes funkci.
CREATE OR REPLACE FUNCTION public.touch_scene(p_scene uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.geo_scenes SET opened_at = now() WHERE id = p_scene AND owner = auth.uid();
  IF NOT FOUND THEN
    UPDATE public.geo_scene_members SET opened_at = now() WHERE scene_id = p_scene AND user_id = auth.uid();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_scene(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_scene(uuid) TO authenticated;
