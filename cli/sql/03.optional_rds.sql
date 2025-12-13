-- Optional permissions for RDS Postgres / Aurora (best effort)

create extension if not exists rds_tools;
grant execute on function rds_tools.pg_ls_multixactdir() to {{ROLE_IDENT}};


