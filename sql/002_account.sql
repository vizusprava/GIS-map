-- ════════════════════════════════════════════════════════════════════════════════
-- Geo Studio — správa účtu (Nastavení účtu v appce)
--
-- Spustit v SQL editoru Supabase (Dashboard → SQL Editor → New query → vložit → Run),
-- až po 001_init.sql. Skript je idempotentní, opakované spuštění nic nerozbije.
--
--  1) delete_my_account() — uživatel smaže SÁM SEBE. Klient s veřejným klíčem na auth.users
--     nedosáhne, proto funkce běží s právy vlastníka (SECURITY DEFINER), ale smaže vždy jen
--     `auth.uid()`, tedy právě přihlášeného. S ním kaskádou zmizí profil, scény, záznamy
--     souborů i data vieweru (všechno visí na profiles ON DELETE CASCADE).
--     Soubory v bucketu tím NEzmizí — Supabase nedovolí mazat je přímo z databáze, proto je
--     appka maže přes Storage API ještě předtím, než funkci zavolá.
--
--  2) Změna e-mailu se propíše do profilu — profil si e-mail kopíruje při registraci
--     (handle_new_user) a bez tohohle by po změně zůstal starý.
-- ════════════════════════════════════════════════════════════════════════════════

-- ── 1) Smazání vlastního účtu ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Nejsi přihlášený';
  END IF;
  DELETE FROM auth.users WHERE id = uid;
END;
$$;

-- jen přihlášení; anonym ani „public" funkci volat nesmí
REVOKE ALL ON FUNCTION public.delete_my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;

-- ── 2) E-mail v profilu po změně ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_profile_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.profiles SET email = NEW.email WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

-- Trigger funkce nemá co dělat ve veřejném API (/rest/v1/rpc/…) — stejně jako u 001 (bod 8).
-- Triggeru to nevadí, práva se u něj kontrolují při vytvoření, ne při každém spuštění.
REVOKE EXECUTE ON FUNCTION public.sync_profile_email() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;
CREATE TRIGGER on_auth_user_email_changed
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  WHEN (OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.sync_profile_email();
