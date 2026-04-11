FROM node:22-slim

RUN apt-get update && apt-get install -y git curl jq python3 ca-certificates gnupg openssh-client zip unzip chromium xvfb fluxbox x11vnc novnc websockify && \
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

# Prepare writable mount points.
# Steve shares the data volume with per-user agent containers, which may create
# root-owned files. Running Steve as root avoids recurring EACCES failures when
# it later needs to update user workspaces or bundled skills.
RUN mkdir -p /data /vault

VOLUME ["/data", "/vault"]

ENV STEVE_DIR=/data

EXPOSE 3000 3100 6080-6119

CMD ["node", "dist/index.js"]
