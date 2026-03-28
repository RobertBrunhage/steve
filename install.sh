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

if ! command -v docker >/dev/null 2>&1; then
    printf 'Error: docker is required.\n' >&2
    exit 1
fi

docker_compose() {
    docker compose --env-file "\$ENV_FILE" -f "\$COMPOSE_FILE" "\$@"
}

show_url() {
    local host
    host=localhost
    if [[ -f "\$ENV_FILE" ]]; then
        host=$(grep '^STEVE_HOSTNAME=' "\$ENV_FILE" | cut -d= -f2- || true)
    fi
    if [[ -z "\$host" ]]; then
        host=localhost
    fi
    if [[ "\$host" == "localhost" ]]; then
        printf 'Dashboard: http://localhost:3000\n'
    else
        printf 'Dashboard: http://%s.local:3000\n' "\$host"
        printf 'Fallback:  http://localhost:3000\n'
    fi
}

ensure_files() {
    if [[ ! -f "\$COMPOSE_FILE" ]]; then
        printf 'Error: missing compose file at %s\n' "\$COMPOSE_FILE" >&2
        exit 1
    fi
    if [[ ! -f "\$ENV_FILE" ]]; then
        printf 'STEVE_HOSTNAME=${DEFAULT_HOSTNAME}\n' > "\$ENV_FILE"
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
  pull      Pull latest image referenced by compose
  update    Refresh compose file and pull latest image
  setup-url Print the one-time setup URL
  url       Show dashboard URL
  help      Show this help message
USAGE
}

show_setup_url() {
    local host token
    host=localhost
    if [[ -f "\$ENV_FILE" ]]; then
        host=$(grep '^STEVE_HOSTNAME=' "\$ENV_FILE" | cut -d= -f2- || true)
    fi
    token=$(docker exec steve sh -lc 'if [ -f /data/setup-token.json ]; then sed -n "s/.*\"token\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" /data/setup-token.json; fi' 2>/dev/null || true)
    if [[ -z "\$token" ]]; then
        printf 'No pending setup token found. Steve may already be configured.\n' >&2
        exit 1
    fi
    if [[ -z "\$host" || "\$host" == "localhost" ]]; then
        printf 'Setup URL: http://localhost:3000/setup?token=%s\n' "\$token"
    else
        printf 'Setup URL: http://%s.local:3000/setup?token=%s\n' "\$host" "\$token"
    fi
}

ensure_files

cmd=\${1:-help}
case "\$cmd" in
    up)
        docker_compose up -d
        show_url
        ;;
    down)
        docker_compose down
        ;;
    restart)
        docker_compose restart
        show_url
        ;;
    logs)
        docker_compose logs -f
        ;;
    ps)
        docker_compose ps
        ;;
    pull)
        docker_compose pull
        ;;
    update)
        curl -fsSL "\$RAW_BASE/docker-compose.yml" -o "\$COMPOSE_FILE"
        docker_compose pull
        docker_compose up -d
        show_url
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
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

printf '\nSteve is installed.\n'
printf 'Run `%s up` to start again later.\n' "$APP"
printf 'Run `%s logs` to inspect logs.\n' "$APP"
if [[ "$(detect_hostname)" == "localhost" ]]; then
    printf 'Dashboard: http://localhost:3000\n'
else
    printf 'Dashboard: http://%s.local:3000\n' "$(detect_hostname)"
    printf 'Fallback:  http://localhost:3000\n'
fi
