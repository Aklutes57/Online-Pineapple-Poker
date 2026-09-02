FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The database and uploads live wherever PP_DB_PATH / PP_UPLOAD_DIR point —
# mount a volume there in production (fly.toml mounts /data).
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
