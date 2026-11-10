# Nightly backups: encrypted pg_dump of the app's tables + a mirror of the gallery photos.
# pg_dump must be at least the server's major version (Supabase runs Postgres 17).
FROM postgres:17-alpine
RUN apk add --no-cache openssl curl tzdata
COPY ops/backup/*.sh /ops/
RUN sed -i 's/\r$//' /ops/*.sh && chmod +x /ops/*.sh && mkdir -p /backups && chown postgres:postgres /backups
USER postgres
ENTRYPOINT ["/ops/entrypoint.sh"]
