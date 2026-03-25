FROM node:22-slim

RUN apt-get update && apt-get install -y git curl jq python3 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

VOLUME ["/data", "/vault"]

ENV STEVE_DIR=/data \
    STEVE_DOCKER=1

EXPOSE 3000 3100

CMD ["node", "dist/index.js"]
