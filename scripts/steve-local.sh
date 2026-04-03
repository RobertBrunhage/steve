#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
ENV_DIR=${STEVE_LOCAL_ENV_DIR:-$REPO_ROOT/.steve-dev}
ENV_FILE="$ENV_DIR/.env"
AGENTS_COMPOSE_FILE="$ENV_DIR/agents.compose.yml"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
PROJECT_NAME=${STEVE_PROJECT:-steve-dev}
WEB_PORT=${STEVE_WEB_PORT:-7839}
OPENCODE_PORT_BASE=${STEVE_OPENCODE_PORT_BASE:-4456}
TELEGRAM_API_BASE=${STEVE_TELEGRAM_API_BASE:-https://api.telegram.org}

LOCAL_STEVE_IMAGE=${STEVE_IMAGE:-steve-local}
LOCAL_OPENCODE_IMAGE=${STEVE_OPENCODE_IMAGE:-steve-opencode-local}

print_step() {
    printf '\n==> %s\n' "$1"
}

detect_hostname() {
    local host
    host=$(hostname 2>/dev/null || true)
    host=${host%%.local}
    host=${host%%.*}
    if [[ -z "$host" ]]; then
        host=localhost
    fi
    printf '%s\n' "$host"
}

ensure_env() {
    mkdir -p "$ENV_DIR"
    cat > "$ENV_FILE" <<EOF
STEVE_PROJECT=$PROJECT_NAME
STEVE_VERSION=dev
STEVE_WEB_PORT=$WEB_PORT
STEVE_OPENCODE_PORT_BASE=$OPENCODE_PORT_BASE
STEVE_TELEGRAM_API_BASE=$TELEGRAM_API_BASE
STEVE_HOSTNAME=$(detect_hostname)
STEVE_IMAGE=$LOCAL_STEVE_IMAGE
STEVE_OPENCODE_IMAGE=$LOCAL_OPENCODE_IMAGE
STEVE_STATE_DIR_HOST=$ENV_DIR
EOF
}

ensure_agents_compose_file() {
    mkdir -p "$ENV_DIR"
    if [[ ! -f "$AGENTS_COMPOSE_FILE" ]]; then
        printf 'services: {}\n' > "$AGENTS_COMPOSE_FILE"
    fi
}

docker_compose() {
    ensure_env
    ensure_agents_compose_file
    docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$AGENTS_COMPOSE_FILE" "$@"
}

show_url() {
    local host
    host=$(detect_hostname)
    if [[ "$host" == "localhost" ]]; then
        printf 'Dashboard: http://localhost:%s\n' "$WEB_PORT"
    else
        printf 'Dashboard: http://%s.local:%s\n' "$host" "$WEB_PORT"
        printf 'Local:     http://localhost:%s\n' "$WEB_PORT"
    fi
}

show_setup_url() {
    local host token
    host=$(detect_hostname)
    token=$(docker_compose exec -T steve sh -lc 'if [ -f /data/setup-token.json ]; then sed -n "s/.*\"token\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" /data/setup-token.json; fi' 2>/dev/null || true)
    if [[ -z "$token" ]]; then
        printf 'No pending setup token found. Steve may already be configured.\n' >&2
        exit 1
    fi
    if [[ "$host" == "localhost" ]]; then
        printf 'Setup URL: http://localhost:%s/setup?token=%s\n' "$WEB_PORT" "$token"
    else
        printf 'Setup URL: http://%s.local:%s/setup?token=%s\n' "$host" "$WEB_PORT" "$token"
    fi
}

maybe_show_setup_url() {
    local token=""
    for _ in $(seq 1 15); do
        token=$(docker_compose exec -T steve sh -lc 'if [ -f /data/setup-token.json ]; then sed -n "s/.*\"token\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" /data/setup-token.json; fi' 2>/dev/null || true)
        if [[ -n "$token" ]]; then
            show_setup_url
            return
        fi
        sleep 1
    done
}

image_exists() {
    docker image inspect "$1" >/dev/null 2>&1
}

run_image_tool() {
    local workdir=$1
    local mount_dir=$2
    local mount_target=$3
    shift 3
    local env_args=()
    if [[ -n "${STEVE_BACKUP_PASSWORD:-}" ]]; then
        env_args+=( -e "STEVE_BACKUP_PASSWORD=$STEVE_BACKUP_PASSWORD" )
    fi
    if [[ -n "${STEVE_BACKUP_OUTPUT_PATH:-}" ]]; then
        env_args+=( -e "STEVE_BACKUP_OUTPUT_PATH=$STEVE_BACKUP_OUTPUT_PATH" )
    fi
    if [[ -n "${STEVE_BACKUP_OUTPUT_DIR:-}" ]]; then
        env_args+=( -e "STEVE_BACKUP_OUTPUT_DIR=$STEVE_BACKUP_OUTPUT_DIR" )
    fi
    docker run --rm -i \
        --user root \
        -w "$workdir" \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$mount_dir":"$mount_target" \
        -e STEVE_PROJECT="$PROJECT_NAME" \
        -e STEVE_CLI_COMMAND="./steve" \
        ${env_args[@]+"${env_args[@]}"} \
        "$LOCAL_STEVE_IMAGE" "$@"
}

ensure_backup_password() {
    if [[ -n "${STEVE_BACKUP_PASSWORD:-}" ]]; then
        return
    fi
    if [[ ! -t 0 ]]; then
        printf 'Error: backup password required. Set STEVE_BACKUP_PASSWORD when running non-interactively.\n' >&2
        exit 1
    fi
    read -r -s -p 'Backup password: ' STEVE_BACKUP_PASSWORD
    printf '\n'
    export STEVE_BACKUP_PASSWORD
}

backup_steve() {
    ensure_local_images
    ensure_backup_password
    local target=${1:-}
    local host_dir host_file
    if [[ -n "$target" ]]; then
        host_dir=$(cd "$(dirname "$target")" && pwd)
        host_file=$(basename "$target")
        STEVE_BACKUP_OUTPUT_PATH="$host_dir/$host_file" run_image_tool /app "$host_dir" /backup node dist/backup.js "/backup/$host_file"
    else
        STEVE_BACKUP_OUTPUT_DIR="$PWD" run_image_tool /app "$PWD" /backup node dist/backup.js
    fi
}

restore_steve() {
    if [[ -z "${1:-}" ]]; then
        printf 'Usage: ./steve restore <backup-file>\n' >&2
        exit 1
    fi
    ensure_local_images
    ensure_backup_password
    docker_compose down >/dev/null 2>&1 || true
    local source=$1
    local host_dir host_file
    host_dir=$(cd "$(dirname "$source")" && pwd)
    host_file=$(basename "$source")
    run_image_tool /app "$host_dir" /backup node dist/restore.js "/backup/$host_file"
}

build_images() {
    print_step "Building Steve image"
    docker build -t "$LOCAL_STEVE_IMAGE" "$REPO_ROOT"
    print_step "Building OpenCode image"
    docker build -t "$LOCAL_OPENCODE_IMAGE" -f "$REPO_ROOT/opencode.Dockerfile" "$REPO_ROOT"
}

ensure_local_images() {
    if image_exists "$LOCAL_STEVE_IMAGE" && image_exists "$LOCAL_OPENCODE_IMAGE"; then
        return
    fi
    build_images
}

usage() {
    cat <<EOF
Steve local helper

Usage: ./steve <command>

Commands:
  build      Build local Steve and OpenCode images
  up         Start Steve locally with local images
  down       Stop Steve
  restart    Restart Steve
  logs       Follow logs
  ps         Show container status
  backup     Create encrypted backup from local dev data
  restore    Restore encrypted backup into local dev data
  update skills [--force]
             Copy bundled skills into every local user workspace
  setup-url  Print the one-time setup URL
  url        Show dashboard URL
  help       Show this help message
EOF
}

update_skills() {
    ensure_local_images
    local args=()
    if [[ -n "${1:-}" ]]; then
        if [[ "$1" == "--force" ]]; then
            args+=("--force")
        else
            printf 'Usage: ./steve update skills [--force]\n' >&2
            exit 1
        fi
    fi
    docker_compose run --rm --no-deps steve node dist/update-skills.js "${args[@]}"
}

cmd=${1:-help}
case "$cmd" in
    build)
        build_images
        ;;
    up)
        ensure_local_images
        print_step "Starting Steve"
        docker_compose up -d
        show_url
        maybe_show_setup_url
        ;;
    down)
        docker_compose down
        ;;
    restart)
        docker_compose restart
        show_url
        maybe_show_setup_url
        ;;
    logs)
        docker_compose logs -f
        ;;
    ps)
        docker_compose ps
        ;;
    backup)
        backup_steve "${2:-}"
        ;;
    restore)
        restore_steve "${2:-}"
        ;;
    update)
        if [[ "${2:-}" == "skills" ]]; then
            update_skills "${3:-}"
        else
            printf 'Usage: ./steve update skills [--force]\n' >&2
            exit 1
        fi
        ;;
    setup-url)
        show_setup_url
        ;;
    url)
        show_url
        ;;
    help|--help|-h)
        usage
        ;;
    *)
        printf 'Unknown command: %s\n\n' "$cmd" >&2
        usage >&2
        exit 1
        ;;
esac
