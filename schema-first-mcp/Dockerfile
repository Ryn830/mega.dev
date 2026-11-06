FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    MODEL_CACHE_DIR=/app/models \
    ONNXRUNTIME_NODE_INSTALL=skip

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

# Download the Whisper model into the image.
RUN node scripts/prefetch-model.mjs

USER node
EXPOSE 3000
CMD ["node", "src/main.mjs"]
