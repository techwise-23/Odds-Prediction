FROM node:22-slim
# Build tools in case better-sqlite3 has no prebuilt binary for the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
# The database goes on the Railway Volume automatically (the app reads RAILWAY_VOLUME_MOUNT_PATH), wherever it is mounted.
# Railway does not allow the VOLUME instruction, so add one in the service settings. Set DB_FILE only to override.
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
