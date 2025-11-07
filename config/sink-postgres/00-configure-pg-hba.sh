#!/bin/bash
# Configure pg_hba.conf to allow trust authentication from Docker networks

cat > ${PGDATA}/pg_hba.conf <<EOF
# PostgreSQL Client Authentication Configuration File
# Custom configuration for sink-postgres container
# Allows passwordless (trust) authentication from Docker network

# TYPE  DATABASE        USER            ADDRESS                 METHOD

# "local" is for Unix domain socket connections only
local   all             all                                     trust

# IPv4 local connections:
host    all             all             127.0.0.1/32            trust

# IPv6 local connections:
host    all             all             ::1/128                 trust

# Allow replication connections from localhost
local   replication     all                                     trust
host    replication     all             127.0.0.1/32            trust
host    replication     all             ::1/128                 trust

# Allow all connections from Docker networks without password
# This is safe because sink-postgres is not exposed externally
host    all             all             172.16.0.0/12           trust
host    all             all             192.168.0.0/16          trust
host    all             all             10.0.0.0/8              trust
EOF

# Reload PostgreSQL configuration
pg_ctl reload -D ${PGDATA}

