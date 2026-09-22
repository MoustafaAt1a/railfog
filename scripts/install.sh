#!/bin/sh
# spec: contracts/platform.contract.md#PLAT-19 — Universal POSIX installer
set -e

# ---------------------------------------------------------------------------
# Terminal Colors (respects NO_COLOR standard)
# ---------------------------------------------------------------------------
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then
  BOLD='\033[1m'
  DIM='\033[2m'
  RESET='\033[0m'
  GREEN='\033[32m'
  RED='\033[31m'
  CYAN='\033[36m'
  YELLOW='\033[33m'
  GRAY='\033[90m'
else
  BOLD=''
  DIM=''
  RESET=''
  GREEN=''
  RED=''
  CYAN=''
  YELLOW=''
  GRAY=''
fi

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
printf "\n"
printf "${BOLD}${CYAN}RailFog CLI Installer${RESET}\n"
printf "${DIM}Trigger -> Function -> {KV, Objects, Queues}${RESET}\n"
printf "\n"

# ---------------------------------------------------------------------------
# Platform Detection
# ---------------------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    TARGET_OS="darwin"
    ;;
  Linux)
    TARGET_OS="linux"
    ;;
  *)
    printf "${RED}[-]${RESET} Unsupported operating system: ${OS}\n" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64)
    TARGET_ARCH="x64"
    ;;
  arm64|aarch64)
    TARGET_ARCH="arm64"
    ;;
  *)
    printf "${RED}[-]${RESET} Unsupported architecture: ${ARCH}\n" >&2
    exit 1
    ;;
esac

printf "${CYAN}[i]${RESET} Platform:  ${TARGET_OS}-${TARGET_ARCH}\n"

INSTALL_DIR="${RAILFOG_INSTALL_DIR:-$HOME/.railfog/bin}"
mkdir -p "$INSTALL_DIR"

BINARY_PATH="$INSTALL_DIR/rail"
DOWNLOAD_URL="https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/dist/rail"

printf "${CYAN}[i]${RESET} Target:    ${BINARY_PATH}\n"
printf "\n"

# ---------------------------------------------------------------------------
# Download / Install
# ---------------------------------------------------------------------------
printf "${DIM}    Downloading RailFog for ${TARGET_OS}-${TARGET_ARCH}...${RESET}\n"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "$BINARY_PATH" || true
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$BINARY_PATH" "$DOWNLOAD_URL" || true
fi

# If direct binary not available yet or in dev, install via Deno if present
if [ ! -f "$BINARY_PATH" ] || [ ! -s "$BINARY_PATH" ]; then
  if command -v deno >/dev/null 2>&1; then
    printf "${YELLOW}[!]${RESET} Binary not available, compiling via local Deno...\n"
    deno install -g -A -f --config https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/deno.json -n rail https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/cli/main.ts
    printf "\n${GREEN}[+]${RESET} ${BOLD}RailFog CLI installed successfully!${RESET}\n"
    printf "    Run ${BOLD}rail --help${RESET} or ${BOLD}rail login${RESET} to get started!\n\n"
    exit 0
  else
    printf "${YELLOW}[!]${RESET} Creating bootstrap runner...\n"
    cat << 'EOF' > "$BINARY_PATH"
#!/bin/sh
exec deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/cli/main.ts "$@"
EOF
  fi
fi

chmod +x "$BINARY_PATH"

printf "${GREEN}[+]${RESET} RailFog CLI installed to ${BOLD}${BINARY_PATH}${RESET}\n"

# ---------------------------------------------------------------------------
# PATH Check
# ---------------------------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf "\n"
    printf "${YELLOW}[!]${RESET} ${INSTALL_DIR} is not in your PATH.\n"
    printf "    Add the following line to your shell profile (~/.bashrc, ~/.zshrc, or ~/.profile):\n"
    printf "\n"
    printf "      ${BOLD}export PATH=\"${INSTALL_DIR}:\$PATH\"${RESET}\n"
    printf "\n"
    ;;
esac

# ---------------------------------------------------------------------------
# Success Card
# ---------------------------------------------------------------------------
printf "\n"
printf "${GRAY}┌── ${RESET}${BOLD}RailFog CLI${RESET}${GRAY} ──────────────────────────────────┐${RESET}\n"
printf "${GRAY}│${RESET}                                                  ${GRAY}│${RESET}\n"
printf "${GRAY}│${RESET}  ${GREEN}[+]${RESET} Installation complete                       ${GRAY}│${RESET}\n"
printf "${GRAY}│${RESET}                                                  ${GRAY}│${RESET}\n"
printf "${GRAY}│${RESET}  ${DIM}Executable:${RESET}  %-36s${GRAY}│${RESET}\n" "$BINARY_PATH"
printf "${GRAY}│${RESET}  ${DIM}Platform:${RESET}    %-36s${GRAY}│${RESET}\n" "${TARGET_OS}-${TARGET_ARCH}"
printf "${GRAY}│${RESET}                                                  ${GRAY}│${RESET}\n"
printf "${GRAY}│${RESET}  Run ${BOLD}rail --help${RESET} or ${BOLD}rail login${RESET} to get started!  ${GRAY}│${RESET}\n"
printf "${GRAY}│${RESET}                                                  ${GRAY}│${RESET}\n"
printf "${GRAY}└──────────────────────────────────────────────────┘${RESET}\n"
printf "\n"
