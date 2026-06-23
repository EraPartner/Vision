# Postgres preloaded with the Vision synthetic demo dataset.
# The SQL in /docker-entrypoint-initdb.d runs automatically the first time the
# data volume is initialized (empty), so the Vision Demo app boots with data.
FROM postgres:18-alpine
COPY 01-demo.sql /docker-entrypoint-initdb.d/01-demo.sql
