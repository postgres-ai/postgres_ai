-- Drop the monitoring role created by prepare-db (template-filled by cli/lib/init.ts)
-- This must run after revoking all permissions from the role.

-- Use a DO block to handle the case where the role doesn't exist
do $$ begin
  -- Reassign owned objects to current user before dropping
  -- This handles any objects that might have been created by the role
  begin
    execute format('reassign owned by %I to current_user', {{ROLE_LITERAL}});
  exception when undefined_object then
    null; -- Role doesn't exist, nothing to reassign
  end;

  -- Drop owned objects (in case reassign didn't work for some objects)
  begin
    execute format('drop owned by %I', {{ROLE_LITERAL}});
  exception when undefined_object then
    null; -- Role doesn't exist
  end;

  -- Drop the role
  begin
    drop role {{ROLE_IDENT}};
  exception when undefined_object then
    null; -- Role doesn't exist, that's fine
  end;
end $$;
