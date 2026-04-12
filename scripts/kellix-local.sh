#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
ENV_DIR=${KELLIX_LOCAL_ENV_DIR:-${STEVE_LOCAL_ENV_DIR:-$REPO_ROOT/.kellix-dev}}
ENV_FILE="$ENV_DIR/.env"
AGENTS_COMPOSE_FILE="$ENV_DIR/agents.compose.yml"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
PROJECT_NAME=${KELLIX_PROJECT:-${STEVE_PROJECT:-kellix-dev}}
WEB_PORT=${KELLIX_WEB_PORT:-${STEVE_WEB_PORT:-7839}}
OPENCODE_PORT_BASE=${KELLIX_OPENCODE_PORT_BASE:-${STEVE_OPENCODE_PORT_BASE:-4456}}
BROWSER_VIEWER_PORT_BASE=${KELLIX_BROWSER_VIEWER_PORT_BASE:-${STEVE_BROWSER_VIEWER_PORT_BASE:-6180}}
BROWSER_VIEWER_PORT_MAX=${KELLIX_BROWSER_VIEWER_PORT_MAX:-${STEVE_BROWSER_VIEWER_PORT_MAX:-6219}}
REMOTE_BROWSER_PORT=${KELLIX_REMOTE_BROWSER_PORT:-${STEVE_REMOTE_BROWSER_PORT:-4782}}
TELEGRAM_API_BASE=${KELLIX_TELEGRAM_API_BASE:-${STEVE_TELEGRAM_API_BASE:-https://api.telegram.org}}
REMOTE_BROWSER_PIDFILE="$ENV_DIR/remote-browserd.pid"
REMOTE_BROWSER_LOG="$ENV_DIR/remote-browserd.log"
REMOTE_BROWSER_STATEFILE="$ENV_DIR/remote-browser.json"

LOCAL_KELLIX_IMAGE=${KELLIX_IMAGE:-${STEVE_IMAGE:-kellix-local}}
LOCAL_OPENCODE_IMAGE=${KELLIX_OPENCODE_IMAGE:-${STEVE_OPENCODE_IMAGE:-kellix-opencode-local}}

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
KELLIX_PROJECT=$PROJECT_NAME
KELLIX_VERSION=dev
KELLIX_WEB_PORT=$WEB_PORT
KELLIX_OPENCODE_PORT_BASE=$OPENCODE_PORT_BASE
KELLIX_BROWSER_VIEWER_PORT_BASE=$BROWSER_VIEWER_PORT_BASE
KELLIX_BROWSER_VIEWER_PORT_MAX=$BROWSER_VIEWER_PORT_MAX
KELLIX_TELEGRAM_API_BASE=$TELEGRAM_API_BASE
KELLIX_HOSTNAME=$(detect_hostname)
KELLIX_IMAGE=$LOCAL_KELLIX_IMAGE
KELLIX_OPENCODE_IMAGE=$LOCAL_OPENCODE_IMAGE
KELLIX_STATE_DIR_HOST=$ENV_DIR
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

browserd_running() {
    if curl -sf "http://127.0.0.1:$REMOTE_BROWSER_PORT/health" >/dev/null 2>&1; then
        return 0
    fi
    if [[ -f "$REMOTE_BROWSER_PIDFILE" ]]; then
        local pid
        pid=$(cat "$REMOTE_BROWSER_PIDFILE" 2>/dev/null || true)
        if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

sync_browserd_runtime_files() {
    mkdir -p "$ENV_DIR"
    local pid
    pid=$(pgrep -f "$REPO_ROOT/dist/browser/remote-companion.js" | head -n 1 || true)
    if [[ -n "$pid" ]]; then
        printf '%s\n' "$pid" > "$REMOTE_BROWSER_PIDFILE"
    fi
    cat > "$REMOTE_BROWSER_STATEFILE" <<EOF
{
  "remoteEnabled": true,
  "remoteBaseUrl": "http://host.docker.internal:$REMOTE_BROWSER_PORT"
}
EOF
}

start_browserd() {
    ensure_env
    if browserd_running; then
        sync_browserd_runtime_files
        return
    fi
    if [[ ! -f "$REPO_ROOT/dist/browser/remote-companion.js" ]]; then
        pnpm build >/dev/null
    fi
    mkdir -p "$ENV_DIR"
    KELLIX_REMOTE_BROWSER_PORT="$REMOTE_BROWSER_PORT" \
    KELLIX_REMOTE_BROWSER_ROOT="$ENV_DIR/remote-browser" \
    KELLIX_REMOTE_BROWSER_CONTAINER_ROOT="/state/remote-browser" \
    KELLIX_REMOTE_BROWSER_PIDFILE="$REMOTE_BROWSER_PIDFILE" \
    node "$REPO_ROOT/dist/browser/remote-companion.js" >> "$REMOTE_BROWSER_LOG" 2>&1 &
    local pid=$!
    printf '%s\n' "$pid" > "$REMOTE_BROWSER_PIDFILE"
    for _ in $(seq 1 40); do
        if curl -sf "http://127.0.0.1:$REMOTE_BROWSER_PORT/health" >/dev/null 2>&1; then
            sync_browserd_runtime_files
            return
        fi
        sleep 0.25
    done
    printf 'Warning: remote browser companion did not become ready on port %s\n' "$REMOTE_BROWSER_PORT" >&2
}

stop_browserd() {
    local pid
    if browserd_running; then
        if [[ -f "$REMOTE_BROWSER_PIDFILE" ]]; then
            pid=$(cat "$REMOTE_BROWSER_PIDFILE" 2>/dev/null || true)
        else
            pid=$(pgrep -f "$REPO_ROOT/dist/browser/remote-companion.js" | head -n 1 || true)
        fi
        if [[ -n "$pid" ]]; then
            kill "$pid" >/dev/null 2>&1 || true
        fi
    fi
    rm -f "$REMOTE_BROWSER_PIDFILE"
    rm -f "$REMOTE_BROWSER_STATEFILE"
}

show_setup_url() {
    local host token
    host=$(detect_hostname)
    token=$(docker_compose exec -T kellix sh -lc 'if [ -f /data/setup-token.json ]; then sed -n "s/.*\"token\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" /data/setup-token.json; fi' 2>/dev/null || true)
    if [[ -z "$token" ]]; then
        printf 'No pending setup token found. Kellix may already be configured.\n' >&2
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
        token=$(docker_compose exec -T kellix sh -lc 'if [ -f /data/setup-token.json ]; then sed -n "s/.*\"token\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" /data/setup-token.json; fi' 2>/dev/null || true)
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
    if [[ -n "${KELLIX_BACKUP_PASSWORD:-}" ]]; then
        env_args+=( -e "KELLIX_BACKUP_PASSWORD=$KELLIX_BACKUP_PASSWORD" )
    fi
    if [[ -n "${KELLIX_BACKUP_OUTPUT_PATH:-}" ]]; then
        env_args+=( -e "KELLIX_BACKUP_OUTPUT_PATH=$KELLIX_BACKUP_OUTPUT_PATH" )
    fi
    if [[ -n "${KELLIX_BACKUP_OUTPUT_DIR:-}" ]]; then
        env_args+=( -e "KELLIX_BACKUP_OUTPUT_DIR=$KELLIX_BACKUP_OUTPUT_DIR" )
    fi
    docker run --rm -i \
        --user root \
        -w "$workdir" \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$mount_dir":"$mount_target" \
        -e KELLIX_PROJECT="$PROJECT_NAME" \
        -e KELLIX_CLI_COMMAND="./kellix" \
        ${env_args[@]+"${env_args[@]}"} \
        "$LOCAL_KELLIX_IMAGE" "$@"
}

ensure_backup_password() {
    if [[ -n "${KELLIX_BACKUP_PASSWORD:-}" ]]; then
        return
    fi
    if [[ ! -t 0 ]]; then
        printf 'Error: backup password required. Set KELLIX_BACKUP_PASSWORD when running non-interactively.\n' >&2
        exit 1
    fi
    read -r -s -p 'Backup password: ' KELLIX_BACKUP_PASSWORD
    printf '\n'
    export KELLIX_BACKUP_PASSWORD
}

backup_kellix() {
    ensure_local_images
    ensure_backup_password
    local target=${1:-}
    local host_dir host_file
    if [[ -n "$target" ]]; then
        host_dir=$(cd "$(dirname "$target")" && pwd)
        host_file=$(basename "$target")
        KELLIX_BACKUP_OUTPUT_PATH="$host_dir/$host_file" run_image_tool /app "$host_dir" /backup node dist/backup.js "/backup/$host_file"
    else
        host_dir="$PWD"
        host_file="kellix-backup-$(date +%F).enc"
        KELLIX_BACKUP_OUTPUT_PATH="$host_dir/$host_file" run_image_tool /app "$host_dir" /backup node dist/backup.js "/backup/$host_file"
    fi
}

restore_kellix() {
    if [[ -z "${1:-}" ]]; then
        printf 'Usage: ./kellix restore <backup-file>\n' >&2
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
    print_step "Building Kellix image"
    docker build -t "$LOCAL_KELLIX_IMAGE" "$REPO_ROOT"
    print_step "Building OpenCode image"
    docker build -t "$LOCAL_OPENCODE_IMAGE" -f "$REPO_ROOT/opencode.Dockerfile" "$REPO_ROOT"
}

ensure_local_images() {
    if image_exists "$LOCAL_KELLIX_IMAGE" && image_exists "$LOCAL_OPENCODE_IMAGE"; then
        return
    fi
    build_images
}

usage() {
    cat <<EOF
Kellix local helper

Usage: ./kellix <command>

Commands:
  build      Build local Kellix and OpenCode images
  up         Start Kellix locally with local images
  down       Stop Kellix
  restart    Restart Kellix
  logs       Follow logs
  ps         Show container status
  backup     Create encrypted backup from local dev data
  restore    Restore encrypted backup into local dev data
  update skills [--force]
             Copy bundled skills into every local user workspace
  browser up Start the local remote browser companion
  browser down
             Stop the local remote browser companion
  browser status
             Show local remote browser companion status
  browser logs
             Follow local remote browser companion logs
  setup-url  Print the one-time setup URL
  url        Show dashboard URL
  help       Show this help message
EOF
}

browser_status() {
    if browserd_running; then
        printf 'Remote browser companion: running on http://127.0.0.1:%s\n' "$REMOTE_BROWSER_PORT"
    else
        printf 'Remote browser companion: stopped\n'
    fi
}

update_skills() {
    ensure_local_images
    local args=()
    if [[ -n "${1:-}" ]]; then
        if [[ "$1" == "--force" ]]; then
            args+=("--force")
        else
            printf 'Usage: ./kellix update skills [--force]\n' >&2
            exit 1
        fi
    fi
    docker_compose run --rm --no-deps kellix node dist/update-skills.js "${args[@]}"
}

cmd=${1:-help}
case "$cmd" in
    build)
        build_images
        ;;
    up)
        ensure_local_images
        print_step "Starting Kellix"
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
        backup_kellix "${2:-}"
        ;;
    restore)
        restore_kellix "${2:-}"
        ;;
    update)
        if [[ "${2:-}" == "skills" ]]; then
            update_skills "${3:-}"
        else
            printf 'Usage: ./kellix update skills [--force]\n' >&2
            exit 1
        fi
        ;;
    browser)
        case "${2:-status}" in
            up)
                start_browserd
                browser_status
                ;;
            down)
                stop_browserd
                browser_status
                ;;
            status)
                browser_status
                ;;
            logs)
                mkdir -p "$ENV_DIR"
                touch "$REMOTE_BROWSER_LOG"
                tail -f "$REMOTE_BROWSER_LOG"
                ;;
            *)
                printf 'Usage: ./kellix browser <up|down|status|logs>\n' >&2
                exit 1
                ;;
        esac
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
