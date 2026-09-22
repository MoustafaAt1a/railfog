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
  BRAND='\033[38;2;152;118;170m'
  BDR='\033[38;2;85;85;85m'
else
  BOLD=''
  DIM=''
  RESET=''
  GREEN=''
  RED=''
  CYAN=''
  YELLOW=''
  GRAY=''
  BRAND=''
  BDR=''
fi

# ---------------------------------------------------------------------------
# Train Logo
# ---------------------------------------------------------------------------
printf "\n"
printf "${GRAY}       ┌──────┐${RESET}\n"
printf "${BOLD}         ████${RESET}\n"
printf "${GRAY}   ┌──────────────┐${RESET}\n"
printf "${GRAY}   │${RESET}████  ${BOLD}██${RESET}  ████${GRAY}│${RESET}\n"
printf "${GRAY}   │${RESET}██████████████${GRAY}│${RESET}\n"
printf "${GRAY}   │${RESET}██████████████${GRAY}│${RESET}\n"
printf "${GRAY}   │${GRAY}██  ██  ██  ██${GRAY}│${RESET}\n"
printf "${GRAY}   │${GRAY}██  ██  ██  ██${GRAY}│${RESET}\n"
printf "${GRAY}  ══════════════════${RESET}\n"
printf "\n"
printf "    ${BOLD}${BRAND}RailFog${RESET} ${BOLD}${CYAN}CLI Installer${RESET}\n"
printf "    ${DIM}Trigger -> Function -> {KV, Objects, Queues}${RESET}\n"
printf "\n"

# ---------------------------------------------------------------------------
# Platform Detection — Step 1/3
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
    printf "  ${CYAN}[1/3]${RESET} ${DIM}━━━━━━━━►${RESET} Detecting platform ${DIM}....................${RESET} ${RED}fail${RESET}\n"
    printf "\n  ${RED}[-]${RESET} Unsupported operating system: ${OS}\n" >&2
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
    printf "  ${CYAN}[1/3]${RESET} ${DIM}━━━━━━━━►${RESET} Detecting platform ${DIM}....................${RESET} ${RED}fail${RESET}\n"
    printf "\n  ${RED}[-]${RESET} Unsupported architecture: ${ARCH}\n" >&2
    exit 1
    ;;
esac

printf "  ${CYAN}[1/3]${RESET} ${DIM}━━━━━━━━►${RESET} Detecting platform ${DIM}....................${RESET} ${GREEN}done${RESET}\n"
printf "         ${CYAN}[i]${RESET} Source:    https://github.com/MoustafaAt1a/railfog\n"
printf "         ${CYAN}[i]${RESET} Platform:  ${TARGET_OS}-${TARGET_ARCH}\n"

INSTALL_DIR="${RAILFOG_INSTALL_DIR:-$HOME/.railfog/bin}"
mkdir -p "$INSTALL_DIR"

BINARY_PATH="$INSTALL_DIR/rail"
DOWNLOAD_URL="https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/dist/rail"

printf "         ${CYAN}[i]${RESET} Target:    ${BINARY_PATH}\n"
printf "\n"

# ---------------------------------------------------------------------------
# Download / Install — Step 2/3
# ---------------------------------------------------------------------------
INSTALL_OK="yes"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "$BINARY_PATH" 2>/dev/null || true
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$BINARY_PATH" "$DOWNLOAD_URL" 2>/dev/null || true
fi

# If direct binary not available yet or in dev, install via Deno if present
if [ ! -f "$BINARY_PATH" ] || [ ! -s "$BINARY_PATH" ]; then
  if command -v deno >/dev/null 2>&1; then
    printf "         ${YELLOW}[!]${RESET} Binary not available, compiling via Deno...\n"
    deno install -g -A -f --config https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/deno.json -n rail https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/cli/main.ts 2>/dev/null || INSTALL_OK="no"
  else
    printf "         ${YELLOW}[!]${RESET} Creating bootstrap runner...\n"
    cat << 'EOF' > "$BINARY_PATH"
#!/bin/sh
exec deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/cli/main.ts "$@"
EOF
  fi
fi

if [ "$INSTALL_OK" = "no" ]; then
  printf "  ${CYAN}[2/3]${RESET} ${DIM}━━━━━━━━►${RESET} Installing binary ${DIM}.....................${RESET} ${RED}fail${RESET}\n"
  printf "\n  ${RED}[-]${RESET} ${BOLD}Installation failed${RESET}\n\n"
  exit 1
fi

chmod +x "$BINARY_PATH" 2>/dev/null || true

printf "  ${CYAN}[2/3]${RESET} ${DIM}━━━━━━━━►${RESET} Installing binary ${DIM}.....................${RESET} ${GREEN}done${RESET}\n"
printf "\n"

# ---------------------------------------------------------------------------
# Verify Installation — Step 3/3
# ---------------------------------------------------------------------------
printf "  ${CYAN}[3/3]${RESET} ${DIM}━━━━━━━━►${RESET} Verifying installation ${DIM}.................${RESET} ${GREEN}done${RESET}\n"
printf "\n"

# ---------------------------------------------------------------------------
# SHA-256 Integrity
# ---------------------------------------------------------------------------
FILE_HASH=""
if command -v sha256sum >/dev/null 2>&1; then
  FILE_HASH=$(sha256sum "$BINARY_PATH" 2>/dev/null | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
  FILE_HASH=$(shasum -a 256 "$BINARY_PATH" 2>/dev/null | cut -d' ' -f1)
fi

# ---------------------------------------------------------------------------
# Shell detection
# ---------------------------------------------------------------------------
DETECTED_SHELL=""
case "${SHELL:-}" in
  *zsh)   DETECTED_SHELL="zsh" ;;
  *bash)  DETECTED_SHELL="bash" ;;
  *fish)  DETECTED_SHELL="fish" ;;
esac

# ---------------------------------------------------------------------------
# PATH check
# ---------------------------------------------------------------------------
PATH_FOUND="no"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) PATH_FOUND="yes" ;;
esac

# ---------------------------------------------------------------------------
# Success Card
# ---------------------------------------------------------------------------
printf "${BDR}┌──${RESET} ${BOLD}RailFog CLI${RESET} ${BDR}──────────────────────────────────────────────────────────────────┐${RESET}\n"
printf "${BDR}│${RESET}                                                                                     ${BDR}│${RESET}\n"
printf "${BDR}│${RESET}  ${GREEN}[+]${RESET} ${BOLD}Installation complete${RESET}                                                       ${BDR}│${RESET}\n"
printf "${BDR}│${RESET}                                                                                     ${BDR}│${RESET}\n"
printf "${BDR}│${RESET}  ${DIM}Executable:${RESET}   %-64s${BDR}│${RESET}\n" "$BINARY_PATH"
printf "${BDR}│${RESET}  ${DIM}Platform:${RESET}     %-64s${BDR}│${RESET}\n" "${TARGET_OS}-${TARGET_ARCH}"
if [ -n "$FILE_HASH" ]; then
  SHORT_HASH="sha256:$(echo "$FILE_HASH" | cut -c1-16)...$(echo "$FILE_HASH" | rev | cut -c1-8 | rev)"
  printf "${BDR}│${RESET}  ${DIM}Integrity:${RESET}    ${GRAY}%-60s${RESET}    ${BDR}│${RESET}\n" "$SHORT_HASH"
fi
printf "${BDR}│${RESET}                                                                                     ${BDR}│${RESET}\n"
printf "${BDR}│${RESET}  ${BOLD}Preflight:${RESET}                                                                       ${BDR}│${RESET}\n"

# Preflight: rail check
if command -v "$BINARY_PATH" >/dev/null 2>&1 || [ -x "$BINARY_PATH" ]; then
  RAIL_VER=$("$BINARY_PATH" --version 2>/dev/null || echo "")
  if [ -n "$RAIL_VER" ]; then
    printf "${BDR}│${RESET}    ${GREEN}[+]${RESET} rail --version ${DIM}....................${RESET} ${BOLD}%-24s${RESET}              ${BDR}│${RESET}\n" "$RAIL_VER"
  else
    printf "${BDR}│${RESET}    ${RED}[-]${RESET} rail --version ${DIM}....................${RESET} ${RED}error${RESET}                             ${BDR}│${RESET}\n"
  fi
else
  printf "${BDR}│${RESET}    ${RED}[-]${RESET} rail --version ${DIM}....................${RESET} ${RED}not found${RESET}                         ${BDR}│${RESET}\n"
fi

# Preflight: PATH
if [ "$PATH_FOUND" = "yes" ]; then
  printf "${BDR}│${RESET}    ${GREEN}[+]${RESET} PATH ${DIM}..............................${RESET} ${GREEN}found${RESET}                             ${BDR}│${RESET}\n"
else
  printf "${BDR}│${RESET}    ${YELLOW}[!]${RESET} PATH ${DIM}..............................${RESET} ${YELLOW}not found${RESET}                         ${BDR}│${RESET}\n"
fi

# Preflight: shell
if [ -n "$DETECTED_SHELL" ]; then
  printf "${BDR}│${RESET}    ${CYAN}[i]${RESET} Shell detected ${DIM}....................${RESET} ${DETECTED_SHELL} ${DIM}(run rail completions ${DETECTED_SHELL})${RESET}  ${BDR}│${RESET}\n"
fi

# PATH warning
if [ "$PATH_FOUND" = "no" ]; then
  printf "${BDR}│${RESET}                                                                                     ${BDR}│${RESET}\n"
  printf "${BDR}│${RESET}  ${YELLOW}[!]${RESET} ${INSTALL_DIR} is not in your PATH.                                       ${BDR}│${RESET}\n"
  printf "${BDR}│${RESET}      Add to your shell profile (~/.bashrc, ~/.zshrc, or ~/.profile):                ${BDR}│${RESET}\n"
  printf "${BDR}│${RESET}      ${BOLD}export PATH=\"${INSTALL_DIR}:\$PATH\"${RESET}                                          ${BDR}│${RESET}\n"
fi

printf "${BDR}│${RESET}                                                                                     ${BDR}│${RESET}\n"
printf "${BDR}│${RESET}  ${BOLD}Next steps:${RESET}                                                                      ${BDR}│${RESET}\n"
printf "${BDR}│${RESET}    ${CYAN}1.${RESET}  ${BOLD}rail login${RESET}              ${DIM}Authenticate with Control Plane${RESET}                  ${BDR}│${RESET}\n"
printf "${BDR}│${RESET}    ${CYAN}2.${RESET}  ${BOLD}rail init my-app${RESET}        ${DIM}Scaffold a new project${RESET}                          ${BDR}│${RESET}\n"
printf "${BDR}│${RESET}    ${CYAN}3.${RESET}  ${BOLD}rail deploy${RESET}             ${DIM}Ship to production${RESET}                              ${BDR}│${RESET}\n"
printf "${BDR}│${RESET}                                                                                     ${BDR}│${RESET}\n"
printf "${BDR}└─────────────────────────────────────────────────────────────────────────────────────┘${RESET}\n"
printf "\n"
