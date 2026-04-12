FROM ghcr.io/anomalyco/opencode:latest
RUN apk add --no-cache bash curl jq python3 git openssh-client zbar
