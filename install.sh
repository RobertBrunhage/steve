#!/usr/bin/env bash
set -euo pipefail

APP=steve
REPO_SLUG=${STEVE_REPO:-robertbrunhage/steve}
DEFAULT_REF=${STEVE_REF:-main}

INSTALL_ROOT=${STEVE_INSTALL_DIR:-$HOME/.steve}
BIN_DIR="$INSTALL_ROOT/bin"
COMPOSE_FILE="$INSTALL_ROOT/docker-compose.yml"
ENV_FILE="$INSTALL_ROOT/.env"
WRAPPER_PATH="$BIN_DIR/steve"
DEFAULT_HOSTNAME=localhost
DEFAULT_PROJECT=steve
DEFAULT_WEB_PORT=3000
DEFAULT_OPENCODE_PORT_BASE=3456
DEFAULT_STEVE_IMAGE=ghcr.io/robertbrunhage/steve:latest
DEFAULT_OPENCODE_IMAGE=ghcr.io/robertbrunhage/steve-opencode:latest
DEFAULT_TELEGRAM_API_BASE=https://api.telegram.org

requested_ref="$DEFAULT_REF"
no_modify_path=false

usage() {
    cat <<EOF
Steve Installer

Usage: install.sh [options]

Options:
    -h, --help           Display this help message
    -r, --ref <ref>      Install from a git ref (branch, tag, or commit)
        --no-modify-path Don't modify shell config files

Examples:
    curl -fsSL https://raw.githubusercontent.com/robertbrunhage/steve/main/install.sh | bash
    curl -fsSL https://raw.githubusercontent.com/robertbrunhage/steve/main/install.sh | bash -s -- --ref main
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -r|--ref)
            if [[ -n "${2:-}" ]]; then
                requested_ref="$2"
                shift 2
            else
                printf 'Error: --ref requires a value\n' >&2
                exit 1
            fi
            ;;
        --no-modify-path)
            no_modify_path=true
            shift
            ;;
        *)
            printf 'Warning: unknown option %s\n' "$1" >&2
            shift
            ;;
    esac
done

RAW_BASE="https://raw.githubusercontent.com/$REPO_SLUG/$requested_ref"

need_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        printf 'Error: required command not found: %s\n' "$1" >&2
        exit 1
    fi
}

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

download_compose() {
    mkdir -p "$INSTALL_ROOT"
    curl -fsSL "$RAW_BASE/docker-compose.yml" -o "$COMPOSE_FILE"
}

write_env() {
    local host
    host=$(detect_hostname)

    cat > "$ENV_FILE" <<EOF
STEVE_PROJECT=$DEFAULT_PROJECT
STEVE_WEB_PORT=$DEFAULT_WEB_PORT
STEVE_OPENCODE_PORT_BASE=$DEFAULT_OPENCODE_PORT_BASE
STEVE_IMAGE=$DEFAULT_STEVE_IMAGE
STEVE_OPENCODE_IMAGE=$DEFAULT_OPENCODE_IMAGE
STEVE_TELEGRAM_API_BASE=$DEFAULT_TELEGRAM_API_BASE
STEVE_HOSTNAME=$host
EOF
}

write_wrapper() {
    mkdir -p "$BIN_DIR"

    cat > "$WRAPPER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT}"
COMPOSE_FILE="\$INSTALL_ROOT/docker-compose.yml"
ENV_FILE="\$INSTALL_ROOT/.env"
REPO_SLUG="${REPO_SLUG}"
REF="${requested_ref}"
RAW_BASE="https://raw.githubusercontent.com/${REPO_SLUG}/${requested_ref}"
DEFAULT_PROJECT="${DEFAULT_PROJECT}"
DEFAULT_WEB_PORT="${DEFAULT_WEB_PORT}"
DEFAULT_STEVE_IMAGE="${DEFAULT_STEVE_IMAGE}"

if ! command -v docker >/dev/null 2>&1; then
    printf 'Error: docker is required.\n' >&2
    exit 1
fi

docker_compose() {
    docker compose --project-name "\${STEVE_PROJECT:-$DEFAULT_PROJECT}" --env-file "\$ENV_FILE" -f "\$COMPOSE_FILE" "\$@"
}

get_env_value() {
    local key=$1
    if [[ -f "\$ENV_FILE" ]]; then
        grep "^\${key}=" "\$ENV_FILE" | cut -d= -f2- || true
    fi
}

show_url() {
    local host port
    host=localhost
    port=$DEFAULT_WEB_PORT
    if [[ -f "\$ENV_FILE" ]]; then
        host=$(grep '^STEVE_HOSTNAME=' "\$ENV_FILE" | cut -d= -f2- || true)
        port=$(grep '^STEVE_WEB_PORT=' "\$ENV_FILE" | cut -d= -f2- || true)
    fi
    if [[ -z "\$host" ]]; then
        host=localhost
    fi
    if [[ -z "\$port" ]]; then
        port=$DEFAULT_WEB_PORT
    fi
    if [[ "\$host" == "localhost" ]]; then
        printf 'Dashboard: http://localhost:%s\n' "\$port"
    else
        printf 'Dashboard: http://%s.local:%s\n' "\$host" "\$port"
        printf 'Fallback:  http://localhost:%s\n' "\$port"
    fi
}

ensure_files() {
    if [[ ! -f "\$COMPOSE_FILE" ]]; then
        printf 'Error: missing compose file at %s\n' "\$COMPOSE_FILE" >&2
        exit 1
    fi
    if [[ ! -f "\$ENV_FILE" ]]; then
        printf 'STEVE_PROJECT=${DEFAULT_PROJECT}\nSTEVE_WEB_PORT=${DEFAULT_WEB_PORT}\nSTEVE_OPENCODE_PORT_BASE=${DEFAULT_OPENCODE_PORT_BASE}\nSTEVE_IMAGE=${DEFAULT_STEVE_IMAGE}\nSTEVE_OPENCODE_IMAGE=${DEFAULT_OPENCODE_IMAGE}\nSTEVE_TELEGRAM_API_BASE=${DEFAULT_TELEGRAM_API_BASE}\nSTEVE_HOSTNAME=${DEFAULT_HOSTNAME}\n' > "\$ENV_FILE"
    fi
}

usage() {
    cat <<USAGE
Steve helper

Usage: steve <command>

Commands:
  up        Start Steve in the background
  down      Stop Steve
  restart   Restart Steve
  logs      Follow logs
  ps        Show container status
  backup    Create encrypted backup
  restore   Restore encrypted backup
  pull      Pull latest image referenced by compose
  update    Refresh compose file and pull latest image
  setup-url Print the one-time setup URL
  url       Show dashboard URL
  help      Show this help message
USAGE
}

run_image_tool() {
    local workdir=$1
    local mount_dir=$2
    local mount_target=$3
    shift 3
    local image
    image=$(get_env_value STEVE_IMAGE)
    if [[ -z "\$image" ]]; then
        image=$DEFAULT_STEVE_IMAGE
    fi
    docker run --rm -i \
        -w "\$workdir" \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "\$mount_dir":"\$mount_target" \
        -e STEVE_PROJECT="\${STEVE_PROJECT:-$DEFAULT_PROJECT}" \
        "\$image" "\$@"
}

backup_steve() {
    local target=\${1:-}
    local host_dir host_file
    if [[ -n "\$target" ]]; then
        host_dir=$(cd "\$(dirname "\$target")" && pwd)
        host_file=$(basename "\$target")
        run_image_tool /app "\$host_dir" /backup node dist/backup.js "/backup/\$host_file"
    else
        run_image_tool /app "\$PWD" /backup node dist/backup.js
    fi
}

restore_steve() {
    if [[ -z "\${1:-}" ]]; then
        printf 'Usage: steve restore <backup-file>\n' >&2
        exit 1
    fi
    docker_compose down >/dev/null 2>&1 || true
    local source=\$1
    local host_dir host_file
    host_dir=$(cd "\$(dirname "\$source")" && pwd)
    host_file=$(basename "\$source")
    run_image_tool /app "\$host_dir" /backup node dist/restore.js "/backup/\$host_file"
}

show_setup_url() {
    local host port token
    host=localhost
    port=$DEFAULT_WEB_PORT
    if [[ -f "\$ENV_FILE" ]]; then
        host=$(grep '^STEVE_HOSTNAME=' "\$ENV_FILE" | cut -d= -f2- || true)
        port=$(grep '^STEVE_WEB_PORT=' "\$ENV_FILE" | cut -d= -f2- || true)
    fi
    if [[ -z "\$port" ]]; then
        port=$DEFAULT_WEB_PORT
    fi
    token=$(docker_compose exec -T steve sh -lc 'if [ -f /data/setup-token.json ]; then sed -n "s/.*\"token\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" /data/setup-token.json; fi' 2>/dev/null || true)
    if [[ -z "\$token" ]]; then
        printf 'No pending setup token found. Steve may already be configured.\n' >&2
        exit 1
    fi
    if [[ -z "\$host" || "\$host" == "localhost" ]]; then
        printf 'Setup URL: http://localhost:%s/setup?token=%s\n' "\$port" "\$token"
    else
        printf 'Setup URL: http://%s.local:%s/setup?token=%s\n' "\$host" "\$port" "\$token"
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

ensure_files

cmd=\${1:-help}
case "\$cmd" in
    up)
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
        backup_steve "\${2:-}"
        ;;
    restore)
        restore_steve "\${2:-}"
        ;;
    pull)
        docker_compose pull
        ;;
    update)
        curl -fsSL "\$RAW_BASE/docker-compose.yml" -o "\$COMPOSE_FILE"
        docker_compose pull
        docker_compose up -d
        show_url
        maybe_show_setup_url
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
        printf 'Unknown command: %s\n\n' "\$cmd" >&2
        usage >&2
        exit 1
        ;;
esac
EOF

    chmod 755 "$WRAPPER_PATH"
}

add_to_path() {
    local config_file=$1
    local command=$2

    mkdir -p "$(dirname "$config_file")"
    touch "$config_file"

    if grep -Fxq "$command" "$config_file"; then
        return
    fi

    {
        printf '\n# steve\n'
        printf '%s\n' "$command"
    } >> "$config_file"
}

maybe_update_path() {
    local shell_name
    local config_file

    if [[ "$no_modify_path" == true ]]; then
        return
    fi

    if [[ ":$PATH:" == *":$BIN_DIR:"* ]]; then
        return
    fi

    shell_name=$(basename "${SHELL:-}")
    case "$shell_name" in
        fish)
            config_file="$HOME/.config/fish/config.fish"
            add_to_path "$config_file" "fish_add_path $BIN_DIR"
            ;;
        zsh)
            config_file="${ZDOTDIR:-$HOME}/.zshrc"
            add_to_path "$config_file" "export PATH=$BIN_DIR:\$PATH"
            ;;
        *)
            config_file="$HOME/.bashrc"
            add_to_path "$config_file" "export PATH=$BIN_DIR:\$PATH"
            ;;
    esac
}

verify_docker() {
    need_cmd curl
    need_cmd docker

    if ! docker info >/dev/null 2>&1; then
        printf 'Error: Docker is installed but the daemon is not running.\n' >&2
        exit 1
    fi

    if ! docker compose version >/dev/null 2>&1; then
        printf 'Error: docker compose is required.\n' >&2
        exit 1
    fi
}

print_step "Checking prerequisites"
verify_docker

print_step "Downloading compose file"
download_compose

print_step "Writing local configuration"
write_env
write_wrapper
maybe_update_path

print_step "Starting Steve"
docker compose --project-name "$DEFAULT_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

printf '\nSteve is installed.\n'
printf 'Run `%s up` to start again later.\n' "$APP"
printf 'Run `%s logs` to inspect logs.\n' "$APP"
if [[ "$(detect_hostname)" == "localhost" ]]; then
    printf 'Dashboard: http://localhost:%s\n' "$DEFAULT_WEB_PORT"
else
    printf 'Dashboard: http://%s.local:%s\n' "$(detect_hostname)" "$DEFAULT_WEB_PORT"
    printf 'Fallback:  http://localhost:%s\n' "$DEFAULT_WEB_PORT"
fi
maybe_show_setup_url
