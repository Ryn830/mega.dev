FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json server.mjs ./
COPY src ./src
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
