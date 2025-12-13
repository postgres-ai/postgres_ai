-- Role creation / password update (template-filled by cli/lib/init.ts)
--
-- Example expansions (for readability/review):
--   create user "postgres_ai_mon" with password '...';
--   alter user "postgres_ai_mon" with password '...';
--   do $$ begin
--     if not exists (select 1 from pg_catalog.pg_roles where rolname = 'postgres_ai_mon') then
--       create user "postgres_ai_mon" with password '...';
--     else
--       alter user "postgres_ai_mon" with password '...';
--     end if;
--   end $$;
{{ROLE_STMT}}


