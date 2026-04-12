#!/usr/bin/env bash
set -euo pipefail

APP=kellix
REPO_SLUG=${KELLIX_REPO:-${STEVE_REPO:-robertbrunhage/kellix}}
DEFAULT_REF=${KELLIX_REF:-${STEVE_REF:-}}

INSTALL_ROOT=${KELLIX_INSTALL_DIR:-${STEVE_INSTALL_DIR:-$HOME/.kellix}}
BIN_DIR="$INSTALL_ROOT/bin"
COMPOSE_FILE="$INSTALL_ROOT/docker-compose.yml"
AGENTS_COMPOSE_FILE="$INSTALL_ROOT/agents.compose.yml"
ENV_FILE="$INSTALL_ROOT/.env"
WRAPPER_PATH="$BIN_DIR/kellix"
DEFAULT_HOSTNAME=localhost
DEFAULT_PROJECT=kellix
DEFAULT_WEB_PORT=7838
DEFAULT_OPENCODE_PORT_BASE=3456
DEFAULT_BROWSER_VIEWER_PORT_BASE=6080
DEFAULT_BROWSER_VIEWER_PORT_MAX=6119
DEFAULT_KELLIX_IMAGE_REPO=ghcr.io/robertbrunhage/kellix
DEFAULT_OPENCODE_IMAGE_REPO=ghcr.io/robertbrunhage/kellix-opencode
DEFAULT_TELEGRAM_API_BASE=https://api.telegram.org

requested_ref="$DEFAULT_REF"
no_modify_path=false
refresh_wrapper_only=false
RAW_BASE=""
DEFAULT_KELLIX_IMAGE=""
DEFAULT_OPENCODE_IMAGE=""

usage() {
    cat <<EOF
Kellix Installer

Usage: install.sh [options]

Options:
    -h, --help           Display this help message
    -r, --ref <ref>      Install from a git ref (branch, tag, or commit)
    --no-modify-path Don't modify shell config files
    --refresh-wrapper-only
                         Internal: rewrite the installed wrapper only

Examples:
    curl -fsSL https://raw.githubusercontent.com/robertbrunhage/kellix/main/install.sh | bash
    curl -fsSL https://raw.githubusercontent.com/robertbrunhage/kellix/main/install.sh | bash -s -- --ref main
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
        --refresh-wrapper-only)
            refresh_wrapper_only=true
            shift
            ;;
        *)
            printf 'Warning: unknown option %s\n' "$1" >&2
            shift
            ;;
    esac
done

need_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        case "$1" in
            curl)
                printf 'Error: curl is not installed. Install curl, then rerun this command.\n' >&2
                ;;
            docker)
                printf 'Error: Docker is not installed. Install Docker Desktop, open it once, then rerun this command.\n' >&2
                ;;
            *)
                printf 'Error: required command not found: %s\n' "$1" >&2
                ;;
        esac
        exit 1
    fi
}

print_step() {
    printf '\n==> %s\n' "$1"
}

resolve_latest_release_ref() {
    local latest
    latest=$(curl -fsSL "https://api.github.com/repos/$REPO_SLUG/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)
    if [[ -n "$latest" ]]; then
        printf '%s\n' "$latest"
    else
        printf 'main\n'
    fi
}

image_for_ref() {
    local repo=$1
    local ref=$2
    printf '%s:%s\n' "$repo" "$ref"
}

resolve_requested_ref() {
    if [[ -n "$requested_ref" ]]; then
        return
    fi
    requested_ref=$(resolve_latest_release_ref)
}

apply_release_ref() {
    resolve_requested_ref
    RAW_BASE="https://raw.githubusercontent.com/$REPO_SLUG/$requested_ref"
    DEFAULT_KELLIX_IMAGE=$(image_for_ref "$DEFAULT_KELLIX_IMAGE_REPO" "$requested_ref")
    DEFAULT_OPENCODE_IMAGE=$(image_for_ref "$DEFAULT_OPENCODE_IMAGE_REPO" "$requested_ref")
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
KELLIX_RELEASE_REF=$requested_ref
KELLIX_VERSION=$requested_ref
KELLIX_PROJECT=$DEFAULT_PROJECT
KELLIX_WEB_PORT=$DEFAULT_WEB_PORT
KELLIX_OPENCODE_PORT_BASE=$DEFAULT_OPENCODE_PORT_BASE
KELLIX_BROWSER_VIEWER_PORT_BASE=$DEFAULT_BROWSER_VIEWER_PORT_BASE
KELLIX_BROWSER_VIEWER_PORT_MAX=$DEFAULT_BROWSER_VIEWER_PORT_MAX
KELLIX_IMAGE=$DEFAULT_KELLIX_IMAGE
KELLIX_OPENCODE_IMAGE=$DEFAULT_OPENCODE_IMAGE
KELLIX_STATE_DIR_HOST=$INSTALL_ROOT
KELLIX_TELEGRAM_API_BASE=$DEFAULT_TELEGRAM_API_BASE
KELLIX_HOSTNAME=$host
EOF
}

ensure_agents_compose_file_install() {
    mkdir -p "$INSTALL_ROOT"
    if [[ ! -f "$AGENTS_COMPOSE_FILE" ]]; then
        printf 'services: {}\n' > "$AGENTS_COMPOSE_FILE"
    fi
}

write_wrapper() {
    mkdir -p "$BIN_DIR"

    {
        cat <<EOF
#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT}"
COMPOSE_FILE="\$INSTALL_ROOT/docker-compose.yml"
AGENTS_COMPOSE_FILE="\$INSTALL_ROOT/agents.compose.yml"
ENV_FILE="\$INSTALL_ROOT/.env"
REPO_SLUG="${REPO_SLUG}"
REF="${requested_ref}"
DEFAULT_PROJECT="${DEFAULT_PROJECT}"
DEFAULT_WEB_PORT="${DEFAULT_WEB_PORT}"
DEFAULT_BROWSER_VIEWER_PORT_BASE="${DEFAULT_BROWSER_VIEWER_PORT_BASE}"
DEFAULT_BROWSER_VIEWER_PORT_MAX="${DEFAULT_BROWSER_VIEWER_PORT_MAX}"
DEFAULT_OPENCODE_PORT_BASE="${DEFAULT_OPENCODE_PORT_BASE}"
DEFAULT_KELLIX_IMAGE="${DEFAULT_KELLIX_IMAGE}"
DEFAULT_OPENCODE_IMAGE="${DEFAULT_OPENCODE_IMAGE}"
DEFAULT_KELLIX_IMAGE_REPO="${DEFAULT_KELLIX_IMAGE_REPO}"
DEFAULT_OPENCODE_IMAGE_REPO="${DEFAULT_OPENCODE_IMAGE_REPO}"
DEFAULT_TELEGRAM_API_BASE="${DEFAULT_TELEGRAM_API_BASE}"
DEFAULT_HOSTNAME="${DEFAULT_HOSTNAME}"
EOF

        cat <<'EOF'

resolve_latest_release_ref() {
    local latest
    latest=$(curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)
    if [[ -n "$latest" ]]; then
        printf '%s\n' "$latest"
    else
        printf '%s\n' "$REF"
    fi
}

image_for_ref() {
    local repo=$1
    local ref=$2
    printf '%s:%s\n' "$repo" "$ref"
}

if ! command -v docker >/dev/null 2>&1; then
    printf 'Error: Docker is not installed. Install Docker Desktop, open it once, then rerun this command.\n' >&2
    exit 1
fi

docker_compose() {
    ensure_agents_compose_file
    docker compose --project-name "${KELLIX_PROJECT:-$DEFAULT_PROJECT}" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$AGENTS_COMPOSE_FILE" "$@"
}

ensure_agents_compose_file() {
    mkdir -p "$INSTALL_ROOT"
    if [[ ! -f "$AGENTS_COMPOSE_FILE" ]]; then
        printf 'services: {}\n' > "$AGENTS_COMPOSE_FILE"
    fi
}

get_env_value() {
    local key=$1
    if [[ -f "$ENV_FILE" ]]; then
        grep "^${key}=" "$ENV_FILE" | cut -d= -f2- || true
    fi
}

set_env_value() {
    local key=$1
    local value=$2
    local tmp
    tmp=$(mktemp)
    if [[ -f "$ENV_FILE" ]]; then
        awk -F= -v key="$key" -v value="$value" 'BEGIN{updated=0} $1==key {print key "=" value; updated=1; next} {print} END{if(!updated) print key "=" value}' "$ENV_FILE" > "$tmp"
    else
        printf '%s=%s\n' "$key" "$value" > "$tmp"
    fi
    mv "$tmp" "$ENV_FILE"
}

apply_release_ref() {
    local ref=$1
    set_env_value KELLIX_RELEASE_REF "$ref"
    set_env_value KELLIX_VERSION "$ref"
    set_env_value KELLIX_IMAGE "$(image_for_ref "$DEFAULT_KELLIX_IMAGE_REPO" "$ref")"
    set_env_value KELLIX_OPENCODE_IMAGE "$(image_for_ref "$DEFAULT_OPENCODE_IMAGE_REPO" "$ref")"
}

show_url() {
    local host port
    host=localhost
    port=$DEFAULT_WEB_PORT
    if [[ -f "$ENV_FILE" ]]; then
        host=$(grep '^KELLIX_HOSTNAME=' "$ENV_FILE" | cut -d= -f2- || true)
        port=$(grep '^KELLIX_WEB_PORT=' "$ENV_FILE" | cut -d= -f2- || true)
    fi
    if [[ -z "$host" ]]; then
        host=localhost
    fi
    if [[ -z "$port" ]]; then
        port=$DEFAULT_WEB_PORT
    fi
    if [[ "$host" == "localhost" ]]; then
        printf 'Dashboard: http://localhost:%s\n' "$port"
    else
        printf 'Dashboard: http://%s.local:%s\n' "$host" "$port"
        printf 'Local:     http://localhost:%s\n' "$port"
    fi
}

ensure_files() {
    if [[ ! -f "$COMPOSE_FILE" ]]; then
        printf 'Error: missing compose file at %s\n' "$COMPOSE_FILE" >&2
        exit 1
    fi
    if [[ ! -f "$ENV_FILE" ]]; then
        printf 'KELLIX_RELEASE_REF=%s\nKELLIX_VERSION=%s\nKELLIX_PROJECT=%s\nKELLIX_WEB_PORT=%s\nKELLIX_OPENCODE_PORT_BASE=%s\nKELLIX_BROWSER_VIEWER_PORT_BASE=%s\nKELLIX_BROWSER_VIEWER_PORT_MAX=%s\nKELLIX_IMAGE=%s\nKELLIX_OPENCODE_IMAGE=%s\nKELLIX_STATE_DIR_HOST=%s\nKELLIX_TELEGRAM_API_BASE=%s\nKELLIX_HOSTNAME=%s\n' "$REF" "$REF" "$DEFAULT_PROJECT" "$DEFAULT_WEB_PORT" "$DEFAULT_OPENCODE_PORT_BASE" "$DEFAULT_BROWSER_VIEWER_PORT_BASE" "$DEFAULT_BROWSER_VIEWER_PORT_MAX" "$DEFAULT_KELLIX_IMAGE" "$DEFAULT_OPENCODE_IMAGE" "$INSTALL_ROOT" "$DEFAULT_TELEGRAM_API_BASE" "$DEFAULT_HOSTNAME" > "$ENV_FILE"
    fi
    if [[ -z "$(get_env_value KELLIX_STATE_DIR_HOST)" ]]; then
        set_env_value KELLIX_STATE_DIR_HOST "$INSTALL_ROOT"
    fi
    ensure_agents_compose_file
}

refresh_wrapper() {
    local ref=$1
    local tmp
    tmp=$(mktemp)
    curl -fsSL "https://raw.githubusercontent.com/$REPO_SLUG/$ref/install.sh" -o "$tmp"
    KELLIX_INSTALL_DIR="$INSTALL_ROOT" bash "$tmp" --ref "$ref" --refresh-wrapper-only --no-modify-path
    rm -f "$tmp"
}

usage() {
    cat <<USAGE
Kellix helper

Usage: kellix <command>

Commands:
  up        Start Kellix in the background
  down      Stop Kellix
  restart   Restart Kellix
  logs      Follow logs
  ps        Show container status
  backup    Create encrypted backup
  restore   Restore encrypted backup
  pull      Pull the currently configured images
  update    Update Kellix to the newest published release
  update --yolo
            Update Kellix to the latest main build
  update skills [--force]
            Copy bundled skills into every user's workspace
  setup-url Print the one-time setup URL
  url       Show dashboard URL
  help      Show this help message
USAGE
}

update_skills() {
    local args=()
    if [[ -n "${1:-}" ]]; then
        if [[ "$1" == "--force" ]]; then
            args+=("--force")
        else
            printf 'Usage: kellix update skills [--force]\n' >&2
            exit 1
        fi
    fi
    docker_compose run --rm --no-deps kellix node dist/update-skills.js "${args[@]}"
}

run_image_tool() {
    local workdir=$1
    local mount_dir=$2
    local mount_target=$3
    shift 3
    local image
    local env_args=()
    image=$(get_env_value KELLIX_IMAGE)
    if [[ -z "$image" ]]; then
        image=$DEFAULT_KELLIX_IMAGE
    fi
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
        -e KELLIX_PROJECT="${KELLIX_PROJECT:-$DEFAULT_PROJECT}" \
        -e KELLIX_CLI_COMMAND="kellix" \
        ${env_args[@]+"${env_args[@]}"} \
        "$image" "$@"
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
        printf 'Usage: kellix restore <backup-file>\n' >&2
        exit 1
    fi
    ensure_backup_password
    docker_compose down >/dev/null 2>&1 || true
    local source=$1
    local host_dir host_file
    host_dir=$(cd "$(dirname "$source")" && pwd)
    host_file=$(basename "$source")
    run_image_tool /app "$host_dir" /backup node dist/restore.js "/backup/$host_file"
}

show_setup_url() {
    local host port token
    host=localhost
    port=$DEFAULT_WEB_PORT
    if [[ -f "$ENV_FILE" ]]; then
        host=$(grep '^KELLIX_HOSTNAME=' "$ENV_FILE" | cut -d= -f2- || true)
        port=$(grep '^KELLIX_WEB_PORT=' "$ENV_FILE" | cut -d= -f2- || true)
    fi
    if [[ -z "$port" ]]; then
        port=$DEFAULT_WEB_PORT
    fi
    token=$(docker_compose exec -T kellix sh -lc 'if [ -f /data/setup-token.json ]; then sed -n "s/.*\"token\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" /data/setup-token.json; fi' 2>/dev/null || true)
    if [[ -z "$token" ]]; then
        printf 'No pending setup token found. Kellix may already be configured.\n' >&2
        exit 1
    fi
    if [[ -z "$host" || "$host" == "localhost" ]]; then
        printf 'Setup URL: http://localhost:%s/setup?token=%s\n' "$port" "$token"
    else
        printf 'Setup URL: http://%s.local:%s/setup?token=%s\n' "$host" "$port" "$token"
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

ensure_files

cmd=${1:-help}
case "$cmd" in
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
        backup_kellix "${2:-}"
        ;;
    restore)
        restore_kellix "${2:-}"
        ;;
    pull)
        docker_compose pull
        ;;
    update)
        if [[ "${2:-}" == "skills" ]]; then
            update_skills "${3:-}"
        elif [[ "${2:-}" == "--yolo" ]]; then
            next_ref="main"
            curl -fsSL "https://raw.githubusercontent.com/$REPO_SLUG/$next_ref/docker-compose.yml" -o "$COMPOSE_FILE"
            apply_release_ref "$next_ref"
            docker_compose pull
            docker_compose up -d
            if ! refresh_wrapper "$next_ref"; then
                printf 'Warning: updated runtime to %s, but could not refresh the local kellix command wrapper. Rerun the installer if wrapper behavior seems stale.\n' "$next_ref" >&2
            fi
            printf 'YOLO updated Kellix to %s\n' "$next_ref"
            show_url
            maybe_show_setup_url
        else
            next_ref=$(resolve_latest_release_ref)
            curl -fsSL "https://raw.githubusercontent.com/$REPO_SLUG/$next_ref/docker-compose.yml" -o "$COMPOSE_FILE"
            apply_release_ref "$next_ref"
            docker_compose pull
            docker_compose up -d
            if ! refresh_wrapper "$next_ref"; then
                printf 'Warning: updated runtime to %s, but could not refresh the local kellix command wrapper. Rerun the installer if wrapper behavior seems stale.\n' "$next_ref" >&2
            fi
            printf 'Updated Kellix to %s\n' "$next_ref"
            show_url
            maybe_show_setup_url
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
EOF
    } > "$WRAPPER_PATH"

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
        printf '\n# kellix\n'
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

refresh_wrapper_install_only() {
    apply_release_ref
    write_wrapper
}

maybe_show_setup_url_install() {
    local host port token=""
    host=$(detect_hostname)
    port=$DEFAULT_WEB_PORT

    for _ in $(seq 1 15); do
        token=$(docker compose --project-name "$DEFAULT_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$AGENTS_COMPOSE_FILE" exec -T kellix sh -lc 'if [ -f /data/setup-token.json ]; then sed -n "s/.*\"token\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" /data/setup-token.json; fi' 2>/dev/null || true)
        if [[ -n "$token" ]]; then
            if [[ "$host" == "localhost" ]]; then
                printf 'Setup URL: http://localhost:%s/setup?token=%s\n' "$port" "$token"
            else
                printf 'Setup URL: http://%s.local:%s/setup?token=%s\n' "$host" "$port" "$token"
                printf 'Local:     http://localhost:%s/setup?token=%s\n' "$port" "$token"
            fi
            return
        fi
        sleep 1
    done
}

verify_docker() {
    need_cmd curl
    need_cmd docker

    if ! docker info >/dev/null 2>&1; then
        printf 'Error: Docker is installed but not running. Start Docker Desktop, wait until it is ready, then rerun this command.\n' >&2
        exit 1
    fi

    if ! docker compose version >/dev/null 2>&1; then
        printf 'Error: Docker Compose is unavailable. Update Docker Desktop or install the Docker Compose plugin, then rerun this command.\n' >&2
        exit 1
    fi
}

print_step "Checking prerequisites"
if [[ "$refresh_wrapper_only" == true ]]; then
    refresh_wrapper_install_only
    exit 0
fi

verify_docker
apply_release_ref

print_step "Downloading compose file"
download_compose

print_step "Writing local configuration"
write_env
ensure_agents_compose_file_install
write_wrapper
maybe_update_path

print_step "Starting Kellix"
docker compose --project-name "$DEFAULT_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$AGENTS_COMPOSE_FILE" up -d

printf '\nKellix is installed.\n'
printf 'Version: %s\n' "$requested_ref"
printf 'Run `%s up` to start again later.\n' "$APP"
printf 'Run `%s logs` to inspect logs.\n' "$APP"
if [[ "$(detect_hostname)" == "localhost" ]]; then
    printf 'Dashboard: http://localhost:%s\n' "$DEFAULT_WEB_PORT"
else
    printf 'Dashboard: http://%s.local:%s\n' "$(detect_hostname)" "$DEFAULT_WEB_PORT"
    printf 'Local:     http://localhost:%s\n' "$DEFAULT_WEB_PORT"
fi
maybe_show_setup_url_install
