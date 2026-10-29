FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# DB 파일은 /app/data 에 저장된다. 컨테이너를 지워도 남도록 볼륨으로 연결할 것
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
