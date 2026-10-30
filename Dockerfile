FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# 의미 검색 모델을 이미지에 넣는다. 빌드하는 곳에서 인터넷이 안 되면 건너뛰고(키워드 검색만),
# 나중에 models 폴더를 /app/models 에 볼륨으로 연결하면 된다.
ARG DOWNLOAD_MODEL=true
RUN if [ "$DOWNLOAD_MODEL" = "true" ]; then npm run download-model || echo "모델 내려받기 실패 - 키워드 검색만 사용"; fi; mkdir -p models
RUN npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/models ./models
COPY package.json ./
# DB 파일은 /app/data 에 저장된다. 컨테이너를 지워도 남도록 볼륨으로 연결할 것
# 자동 백업은 /app/backups 에 쌓인다. 이것도 볼륨으로 연결할 것
VOLUME ["/app/data", "/app/backups"]
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
