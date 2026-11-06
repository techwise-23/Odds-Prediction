FROM node:22-slim
# Build tools in case better-sqlite3 has no prebuilt binary for the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
# On Railway, attach a Volume mounted at /data (Railway does not allow the VOLUME instruction).
ENV NODE_ENV=production DB_FILE=/data/app.db
EXPOSE 3000
CMD ["node", "src/server.js"]
