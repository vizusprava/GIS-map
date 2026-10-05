-- ════════════════════════════════════════════════════════════════════════════════
-- Geo Studio — odkaz na scénu „jen pro prohlížení" (bez registrace)
--
-- Spustit v SQL editoru Supabase (Dashboard → SQL Editor → New query → vložit → Run),
-- až po 003_sharing.sql. Skript je idempotentní, opakované spuštění nic nerozbije.
--
-- POTŘEBA ZAPNOUT: Authentication → Sign In / Providers → „Allow anonymous sign-ins".
-- Návštěvník odkazu se na pozadí přihlásí jako anonymní uživatel (bez e-mailu a hesla).
--
-- Jak to funguje:
--  • Vlastník scény zapne odkaz → vznikne náhodný kód (`geo_scene_links`). Kdo kód zná,
--    otevře scénu jako host: vidí ji i se soubory, může měřit, ale nic neuloží.
--  • Host se při otevření zapíše do `geo_scene_guests` i s kódem, kterým přišel. Přístup
--    platí, jen dokud je ten kód aktuální — vypnutím odkazu nebo vygenerováním nového
--    přijdou všichni hosté o přístup okamžitě.
--  • Anonymní uživatel nesmí nic zakládat, měnit ani nahrávat (pojistky v bodu 5) — jinak by
--    si kdokoliv mohl udělat anonymní účet a používat úložiště jako bezplatný hosting.
--  • 3D realita v prohlížeči jede na klíč Cesium ion vlastníka scény, má-li ho nastavený;
--    jinak na sdílený zkušební. Klíč je pro prohlížeč, takže si ho host může přečíst —
--    omezit ho jde v Cesium ion na adresu webu.
-- ════════════════════════════════════════════════════════════════════════════════

-- ── 1) Odkazy a hosté ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.geo_scene_links (
  -- jedna scéna = nanejvýš jeden platný odkaz
  scene_id   uuid PRIMARY KEY REFERENCES public.geo_scenes(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.geo_scene_guests (
  scene_id   uuid NOT NULL REFERENCES public.geo_scenes(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- kód, se kterým host přišel; po výměně odkazu přestane sedět a přístup zanikne
  token      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scene_id, user_id)
);

CREATE INDEX IF NOT EXISTS geo_scene_guests_user_idx ON public.geo_scene_guests(user_id);

ALTER TABLE public.geo_scene_links ENABLE ROW LEVEL SECURITY;
-- hosté jsou jen pro funkce níž (SECURITY DEFINER) — přímo k tabulce nikdo
ALTER TABLE public.geo_scene_guests ENABLE ROW LEVEL SECURITY;

-- ── 2) Role ve scéně se rozšiřuje o hosta ──────────────────────────────────────────
-- 'owner' | 'editor' | 'viewer' | 'guest' | NULL
CREATE OR REPLACE FUNCTION public.geo_scene_role(p_scene uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN s.owner = auth.uid() THEN 'owner'
    ELSE coalesce(
      (SELECT m.role FROM public.geo_scene_members m WHERE m.scene_id = s.id AND m.user_id = auth.uid()),
      (SELECT 'guest' FROM public.geo_scene_guests g
         JOIN public.geo_scene_links l ON l.scene_id = g.scene_id AND l.token = g.token
        WHERE g.scene_id = s.id AND g.user_id = auth.uid())
    )
  END
  FROM public.geo_scenes s
  WHERE s.id = p_scene
$$;

-- Host scénu vidí (i se stavem); seznam členů ale ne — ten je jen pro lidi ve scéně.
DROP POLICY IF EXISTS geo_scenes_member_select ON public.geo_scenes;
CREATE POLICY geo_scenes_member_select ON public.geo_scenes
  FOR SELECT TO authenticated
  USING (public.geo_scene_role(id) IN ('editor', 'viewer', 'guest'));

DROP POLICY IF EXISTS geo_scene_members_select ON public.geo_scene_members;
CREATE POLICY geo_scene_members_select ON public.geo_scene_members
  FOR SELECT TO authenticated
  USING (public.geo_scene_role(scene_id) IN ('owner', 'editor', 'viewer'));

-- geo_assets_select (003) pouští každého s rolí, tedy i hosta — soubory scény vidět musí.

-- Odkaz vidí a ruší jen vlastník; zapíná se přes scene_link_enable().
DROP POLICY IF EXISTS geo_scene_links_select ON public.geo_scene_links;
CREATE POLICY geo_scene_links_select ON public.geo_scene_links
  FOR SELECT TO authenticated
  USING (public.geo_scene_role(scene_id) = 'owner');

-- ── 3) Soubory v bucketu: host čte ─────────────────────────────────────────────────
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
  IF EXISTS (
    SELECT 1 FROM public.geo_scene_members m
    WHERE m.scene_id = s AND m.user_id = auth.uid() AND (NOT p_write OR m.role = 'editor')
  ) THEN
    RETURN true;
  END IF;
  -- host s platným odkazem jen čte
  RETURN NOT p_write AND EXISTS (
    SELECT 1 FROM public.geo_scene_guests g
      JOIN public.geo_scene_links l ON l.scene_id = g.scene_id AND l.token = g.token
     WHERE g.scene_id = s AND g.user_id = auth.uid()
  );
END;
$$;

-- ── 4) Zapnutí, výměna a vypnutí odkazu; otevření odkazem ─────────────────────────
-- Vlastník: zapne odkaz a vrátí jeho kód. `p_renew` = nový kód (starý přestane platit).
CREATE OR REPLACE FUNCTION public.scene_link_enable(p_scene uuid, p_renew boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t text := replace(gen_random_uuid()::text, '-', ''); -- 122 náhodných bitů, uhodnout nejde
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.geo_scenes WHERE id = p_scene AND owner = auth.uid()) THEN
    RAISE EXCEPTION 'Odkaz může zapnout jen vlastník scény';
  END IF;
  INSERT INTO public.geo_scene_links AS l (scene_id, token, created_by)
  VALUES (p_scene, t, auth.uid())
  ON CONFLICT (scene_id) DO UPDATE
    SET token      = CASE WHEN p_renew THEN EXCLUDED.token ELSE l.token END,
        created_at = CASE WHEN p_renew THEN now() ELSE l.created_at END
  RETURNING l.token INTO t;
  -- hosté se starým kódem už přístup nemají (role se kontroluje proti aktuálnímu); úklid
  DELETE FROM public.geo_scene_guests WHERE scene_id = p_scene AND token <> t;
  RETURN t;
END;
$$;

-- Vlastník: vypne odkaz — všichni hosté přijdou o přístup.
CREATE OR REPLACE FUNCTION public.scene_link_disable(p_scene uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.geo_scenes WHERE id = p_scene AND owner = auth.uid()) THEN
    RAISE EXCEPTION 'Odkaz může vypnout jen vlastník scény';
  END IF;
  DELETE FROM public.geo_scene_links WHERE scene_id = p_scene;
  DELETE FROM public.geo_scene_guests WHERE scene_id = p_scene;
END;
$$;

-- Kdokoliv přihlášený (i anonymně): otevře scénu odkazem. Vrací id scény, jméno vlastníka
-- a jeho klíč Cesium ion (pro 3D realitu v prohlížeči; NULL = žádný vlastní).
CREATE OR REPLACE FUNCTION public.open_scene_link(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid := auth.uid();
  sid uuid;
  own uuid;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Nejsi přihlášený';
  END IF;
  SELECT k.scene_id, s.owner INTO sid, own
  FROM public.geo_scene_links k JOIN public.geo_scenes s ON s.id = k.scene_id
  WHERE k.token = p_token;
  IF sid IS NULL THEN
    RAISE EXCEPTION 'Odkaz neplatí — vlastník ho mohl vypnout nebo vyměnit za nový';
  END IF;
  IF own <> me THEN
    -- profil zakládá trigger při registraci; pojistka pro případ, že chybí
    INSERT INTO public.profiles (id) VALUES (me) ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.geo_scene_guests (scene_id, user_id, token)
    VALUES (sid, me, p_token)
    ON CONFLICT (scene_id, user_id) DO UPDATE SET token = EXCLUDED.token;
  END IF;
  RETURN jsonb_build_object(
    'scene_id', sid,
    'owner_name', (SELECT nullif(p.display_name, '') FROM public.profiles p WHERE p.id = own),
    'ion_token', (SELECT nullif(trim(u.raw_user_meta_data ->> 'ion_token'), '') FROM auth.users u WHERE u.id = own)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.scene_link_enable(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.scene_link_enable(uuid, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.scene_link_disable(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.scene_link_disable(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.open_scene_link(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_scene_link(text) TO authenticated;

-- ── 5) Anonymní uživatel nic nezakládá, nemění ani nenahrává ──────────────────────
-- RESTRICTIVE pravidla se přidávají ke všem ostatním (musí platit vždy), takže stačí jedno
-- na tabulku a operaci. Číst smí dál podle běžných pravidel (= jen scénu, kam ho pustil odkaz).
CREATE OR REPLACE FUNCTION public.geo_is_anonymous()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
$$;

REVOKE ALL ON FUNCTION public.geo_is_anonymous() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.geo_is_anonymous() TO authenticated;

DO $$
DECLARE
  t text;
  op text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'geo_scenes', 'geo_assets', 'geo_object_colors', 'geo_vegetation',
                           'geo_annotations', 'geo_scene_org', 'geo_model_views', 'geo_materials',
                           'geo_scene_members', 'geo_scene_invites', 'geo_scene_links']
  LOOP
    FOREACH op IN ARRAY ARRAY['insert', 'update', 'delete']
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_no_anon_' || op, t);
      IF op = 'insert' THEN
        EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT public.geo_is_anonymous())',
                       t || '_no_anon_' || op, t);
      ELSE
        EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR %s TO authenticated USING (NOT public.geo_is_anonymous())',
                       t || '_no_anon_' || op, t, upper(op));
      END IF;
    END LOOP;
  END LOOP;

  FOREACH op IN ARRAY ARRAY['insert', 'update', 'delete']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', 'geo_no_anon_' || op);
    IF op = 'insert' THEN
      EXECUTE format($f$CREATE POLICY %I ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
                       WITH CHECK (bucket_id <> 'geo' OR NOT public.geo_is_anonymous())$f$, 'geo_no_anon_' || op);
    ELSE
      EXECUTE format($f$CREATE POLICY %I ON storage.objects AS RESTRICTIVE FOR %s TO authenticated
                       USING (bucket_id <> 'geo' OR NOT public.geo_is_anonymous())$f$, 'geo_no_anon_' || op, upper(op));
    END IF;
  END LOOP;
END $$;

-- ── 6) Úklid anonymních účtů (volitelné) ──────────────────────────────────────────
-- Každý návštěvník odkazu (v novém prohlížeči) je jeden anonymní uživatel. Nevadí to, jen se
-- hromadí. Ručně je jde čas od času smazat tímhle dotazem (hosté zmizí s nimi kaskádou):
--
--   DELETE FROM auth.users
--   WHERE is_anonymous AND coalesce(last_sign_in_at, created_at) < now() - interval '30 days';
--
-- Nebo to nechat dělat automaticky přes rozšíření pg_cron (Database → Extensions → pg_cron):
--
--   SELECT cron.schedule('geo-anon-cleanup', '0 3 * * *', $$
--     DELETE FROM auth.users
--     WHERE is_anonymous AND coalesce(last_sign_in_at, created_at) < now() - interval '30 days'
--   $$);
