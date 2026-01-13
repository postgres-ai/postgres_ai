-- Drop helper functions created by prepare-db (template-filled by cli/lib/init.ts)
-- Run before dropping the postgres_ai schema.

drop function if exists postgres_ai.explain_generic(text, text, text);
drop function if exists postgres_ai.table_describe(text);
