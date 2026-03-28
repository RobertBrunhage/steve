FROM node:22-slim

RUN apt-get update && apt-get install -y git curl jq python3 ca-certificates gnupg openssh-client zip unzip && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Use existing node user (uid 1000) and set ownership
# Add to root group for Docker socket access
RUN mkdir -p /data /vault && chown -R node:node /app /data /vault \
    && usermod -aG root node

VOLUME ["/data", "/vault"]

ENV STEVE_DIR=/data

EXPOSE 3000 3100

USER node
CMD ["node", "dist/index.js"]
