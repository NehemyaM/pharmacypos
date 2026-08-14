# PharmacyPOS backend.
#
# Builds the API and (optionally) the UI, then runs a slim runtime image.
# better-sqlite3 is a native module, so it is compiled in the build stage
# against the same Node version the runtime uses.
#
#   docker build -t pharmacypos .
#   docker run -p 4000:4000 -v pharmacy-data:/data pharmacypos
#
# The database lives on the mounted volume, NOT in the image — a container
# without a volume loses the shop the moment it restarts.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Native build toolchain for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
RUN npm run build


FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as a non-root user; the volume is chowned to it below.
RUN useradd --system --create-home --uid 10001 pharmacy

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# Database and backups live here — mount a volume at /data or lose everything.
ENV PHARMACY_DB=/data/pharmacy.sqlite
ENV PHARMACY_BACKUP_DIR=/data/backups
ENV PORT=4000
ENV HOST=0.0.0.0
RUN mkdir -p /data && chown -R pharmacy:pharmacy /data /app
VOLUME ["/data"]

USER pharmacy
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
