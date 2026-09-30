FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY frontend/package*.json ./frontend/
RUN npm --prefix frontend ci
COPY server ./server
COPY frontend ./frontend
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/omnimail.sqlite
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/frontend/dist ./frontend/dist
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
