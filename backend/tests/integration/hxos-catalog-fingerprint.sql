\pset tuples_only on
\pset format unaligned

-- Physical column order legitimately differs when an existing installation is
-- upgraded with ADD COLUMN. Compare semantic shape, not storage ordinals.
SELECT 'COLUMN|' || table_name || '|' || column_name || '|'
  || data_type || '|' || coalesce(udt_name,'') || '|' || is_nullable || '|'
  || coalesce(column_default,'')
FROM information_schema.columns
WHERE table_schema='public'
ORDER BY table_name,column_name;

SELECT 'CONSTRAINT|' || c.relname || '|' || con.conname || '|' || con.contype::text || '|'
  || pg_get_constraintdef(con.oid,true)
FROM pg_constraint con
JOIN pg_class c ON c.oid=con.conrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public'
ORDER BY c.relname,con.conname;

SELECT 'INDEX|' || tablename || '|' || indexname || '|' || indexdef
FROM pg_indexes
WHERE schemaname='public'
ORDER BY tablename,indexname;

SELECT 'TRIGGER|' || c.relname || '|' || t.tgname || '|' || pg_get_triggerdef(t.oid,true)
FROM pg_trigger t
JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND NOT t.tgisinternal
ORDER BY c.relname,t.tgname;

SELECT 'FUNCTION|' || p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|'
  || encode(digest(pg_get_functiondef(p.oid),'sha256'),'hex')
FROM pg_proc p
JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prokind='f' AND p.proname <> 'hxobs_assert'
ORDER BY p.proname,pg_get_function_identity_arguments(p.oid);

SELECT 'MAJOR_SOURCE|' || action_class || '|' || platform || '|' || source_table || '|'
  || coalesce(trigger_name,'') || '|' || source_contract_version || '|' || privacy_contract
FROM major_action_source_registry
ORDER BY action_class,platform,source_table;
