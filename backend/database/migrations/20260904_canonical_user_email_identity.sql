-- Canonical user-email identity authority.
--
-- Email is not identity-relink authority, but every account writer must still
-- fail closed when two Firebase identities race with case-variant forms of the
-- same address. The original case-sensitive UNIQUE(email) constraint cannot
-- enforce that boundary.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.users
     GROUP BY lower(email)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'HXAUTH-EMAIL-1: canonical email identities require reviewed reconciliation before activation';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS users_canonical_email_identity_uidx
  ON public.users (lower(email));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index index_state
      JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
      JOIN pg_class table_relation ON table_relation.oid = index_state.indrelid
      JOIN pg_namespace table_namespace ON table_namespace.oid = table_relation.relnamespace
     WHERE table_namespace.nspname = 'public'
       AND table_relation.relname = 'users'
       AND index_relation.relname = 'users_canonical_email_identity_uidx'
       AND index_state.indisunique
       AND index_state.indisvalid
       AND index_state.indpred IS NULL
       AND pg_get_expr(index_state.indexprs, index_state.indrelid) = 'lower((email)::text)'
  ) THEN
    RAISE EXCEPTION 'HXAUTH-EMAIL-2: canonical email identity index is not valid and unique';
  END IF;
END;
$$;

COMMENT ON INDEX public.users_canonical_email_identity_uidx IS
  'Database-enforced case-insensitive email collision boundary. Does not grant identity relink authority.';
