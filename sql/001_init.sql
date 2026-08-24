-- ════════════════════════════════════════════════════════════════════════════════
-- Geo Studio — základní schéma (účty, scény, soubory, data vieweru)
--
-- Spustit JEDNOU v SQL editoru čistého Supabase projektu (Dashboard → SQL Editor →
-- New query → vložit → Run). Skript je idempotentní, takže opakované spuštění nic
-- nerozbije.
--
-- Model dat: uživatel → N scén → v každé scéně N souborů (modely, výkresy, rastry)
-- + jeden JSON blob se stavem scény (pohledy kamery, popisky, měření, parcely…).
-- Všechno je vlastněné uživatelem a RLS nikoho jiného k tomu nepustí.
-- ════════════════════════════════════════════════════════════════════════════════

-- ── 1) Profily ──────────────────────────────────────────────────────────────────
-- Zrcadlo auth.users, na které se dá odkazovat z aplikačních tabulek (auth schema
-- je pro frontend nedostupné). Zakládá se automaticky triggerem při registraci.
CREATE TABLE IF NOT EXISTS profiles (
  id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        text,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    -- jméno z registračního formuláře (options.data.display_name), jinak část e-mailu před @
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'display_name', ''), split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── 2) Scény ────────────────────────────────────────────────────────────────────
-- `state` je JSON se vším, co ve scéně není soubor: uložené pohledy kamery, popisky,
-- pulzy, měření, vybrané parcely, podklad, pozadí, rozbalené sekce panelu.
-- Schválně jeden blob a ne 10 tabulek — čte i zapisuje se to vždycky celé naráz.
CREATE TABLE IF NOT EXISTS geo_scenes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner      uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  name       text NOT NULL,
  note       text,
  -- náhled scény v přehledu (cesta v bucketu `geo`, viz níž)
  thumb_path text,
  state      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- poslední otevření → přehled může řadit „naposledy otevřené"
  opened_at  timestamptz
);

CREATE INDEX IF NOT EXISTS geo_scenes_owner_idx ON geo_scenes(owner, updated_at DESC);

-- ── 3) Soubory scény ────────────────────────────────────────────────────────────
-- Jeden řádek = jeden nahraný soubor (model / výkres / rastr). Binárka leží ve
-- Storage bucketu `geo` pod `{owner}/{scene_id}/{asset_id}.{ext}`; tady je jen
-- metadata + `config` (usazení modelu, výška a průhlednost výkresu, CRS rastru…).
CREATE TABLE IF NOT EXISTS geo_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id     uuid NOT NULL REFERENCES geo_scenes(id) ON DELETE CASCADE,
  owner        uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('model', 'drawing', 'raster')),
  name         text NOT NULL,
  -- původní název souboru — z něj se pozná typ (.glb/.dxf/.tif) i geo-kotva v názvu
  file_name    text NOT NULL,
  file_path    text NOT NULL,
  -- doprovodný soubor: world file rastru (.jgw/.tfw/.wld) nebo .prj
  sidecar_path text,
  sidecar_name text,
  size_bytes   bigint,
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS geo_assets_scene_idx ON geo_assets(scene_id, sort_order);
CREATE INDEX IF NOT EXISTS geo_assets_owner_idx ON geo_assets(owner);

-- ── 4) Data 3D vieweru (editor modelu) ──────────────────────────────────────────
-- Viewer z `viewer-core` si ukládá anotace, vegetaci, barvy objektů, organizaci
-- scény a pohledy kamery. Klíčem je `asset_id` = model v knihovně scény, takže
-- data přežijí i znovunahrání souboru (řádek se nemění).
CREATE TABLE IF NOT EXISTS geo_object_colors (
  asset_id    uuid NOT NULL REFERENCES geo_assets(id) ON DELETE CASCADE,
  object_name text NOT NULL,
  color       text NOT NULL,
  owner       uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, object_name)
);

CREATE TABLE IF NOT EXISTS geo_vegetation (
  asset_id   uuid PRIMARY KEY REFERENCES geo_assets(id) ON DELETE CASCADE,
  data       jsonb NOT NULL,
  owner      uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS geo_annotations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES geo_assets(id) ON DELETE CASCADE,
  owner        uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  x            double precision NOT NULL,
  y            double precision NOT NULL,
  z            double precision NOT NULL,
  text         text NOT NULL,
  object_name  text,
  offset_x     double precision NOT NULL DEFAULT 0,
  offset_y     double precision NOT NULL DEFAULT 0,
  extra_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  color        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS geo_annotations_asset_idx ON geo_annotations(asset_id, created_at);

CREATE TABLE IF NOT EXISTS geo_scene_org (
  asset_id   uuid PRIMARY KEY REFERENCES geo_assets(id) ON DELETE CASCADE,
  data       jsonb NOT NULL,
  owner      uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS geo_model_views (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES geo_assets(id) ON DELETE CASCADE,
  owner          uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  name           text NOT NULL,
  camera         jsonb NOT NULL,
  annotation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS geo_model_views_asset_idx ON geo_model_views(asset_id, sort_order);

-- Knihovna PBR materiálů je osobní (ne per scéna) — nahraješ dlažbu jednou a použiješ
-- ji kdekoliv. Textury leží v bucketu `geo` pod `{owner}/textures/{material_id}/`.
CREATE TABLE IF NOT EXISTS geo_materials (
  id         uuid PRIMARY KEY,
  owner      uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS geo_materials_owner_idx ON geo_materials(owner);

-- ── 5) `updated_at` se dopisuje sám ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['geo_scenes', 'geo_assets', 'geo_object_colors', 'geo_vegetation',
                           'geo_scene_org', 'geo_materials']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t || '_touch', t);
  END LOOP;
END $$;

-- ── 6) RLS: každý vidí a mění jen svoje ─────────────────────────────────────────
-- Jednotný vzor pro všechny tabulky se sloupcem `owner`: SELECT/INSERT/UPDATE/DELETE
-- jen pro řádky, kde owner = přihlášený uživatel. Anonymní přístup nikam.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['geo_scenes', 'geo_assets', 'geo_object_colors', 'geo_vegetation',
                           'geo_annotations', 'geo_scene_org', 'geo_model_views', 'geo_materials']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_owner_all', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
        FOR ALL TO authenticated
        USING (owner = auth.uid())
        WITH CHECK (owner = auth.uid())
    $f$, t || '_owner_all', t);
  END LOOP;
END $$;

-- profiles: čtení i úprava jen vlastního profilu (insert dělá trigger jako SECURITY DEFINER)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_self_select ON profiles;
CREATE POLICY profiles_self_select ON profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

DROP POLICY IF EXISTS profiles_self_update ON profiles;
CREATE POLICY profiles_self_update ON profiles
  FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- ── 7) Storage bucket na soubory ────────────────────────────────────────────────
-- Privátní bucket `geo`; soubory se servírují jen přes dočasné signed URL. Cesta
-- VŽDY začíná id vlastníka (`{owner}/…`) — na tom stojí celá izolace v RLS níž.
INSERT INTO storage.buckets (id, name, public)
VALUES ('geo', 'geo', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DO $$
DECLARE op text;
BEGIN
  FOREACH op IN ARRAY ARRAY['select', 'insert', 'update', 'delete']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', 'geo_own_' || op);
  END LOOP;
END $$;

CREATE POLICY geo_own_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'geo' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY geo_own_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'geo' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY geo_own_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'geo' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'geo' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY geo_own_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'geo' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ── 8) Zpřísnění podle Supabase security linteru ────────────────────────────────
-- Trigger funkce nemají co pohledávat ve veřejném REST API (/rest/v1/rpc/...).
-- POZOR: nestačí odebrat právo rolím anon/authenticated — EXECUTE drží pseudo-role
-- PUBLIC (v `pg_proc.proacl` vidět jako `=X/postgres`) a obě role ho z ní dědí.
-- Triggerům to nevadí: práva se u nich kontrolují při vytvoření triggeru, ne při
-- každém spuštění, takže registrace i `updated_at` fungují dál.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;

-- `rls_auto_enable` je pojistka od Supabase (sama zapíná RLS na nových tabulkách
-- v public). Není naše, ale linter ji hlásí ze stejného důvodu — a odebrání EXECUTE
-- jí neublíží, protože event trigger si ji volá jako definer.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable') THEN
    REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
  END IF;
END $$;
