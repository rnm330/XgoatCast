# Deployment image: overlay locally built artifacts onto the last known-good
# runtime image. This avoids downloading Node headers or rebuilding
# better-sqlite3 on the production host.
FROM xgoatcast-xgoatcast:latest

USER root
RUN rm -rf /app/server/dist /app/web/dist
COPY server/dist /app/server/dist
COPY web/dist /app/web/dist
