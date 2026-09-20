#!/bin/sh
# spec: contracts/platform.contract.md#PLAT-19 — Universal POSIX installer
set -e

echo "=== Installing RailFog CLI (rail) ==="

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
    echo "Error: Unsupported operating system: $OS" >&2
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
    echo "Error: Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

INSTALL_DIR="${RAILFOG_INSTALL_DIR:-$HOME/.railfog/bin}"
mkdir -p "$INSTALL_DIR"

BINARY_PATH="$INSTALL_DIR/rail"
DOWNLOAD_URL="https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/dist/rail"

echo "Downloading RailFog for ${TARGET_OS}-${TARGET_ARCH} to $BINARY_PATH..."

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "$BINARY_PATH" || true
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$BINARY_PATH" "$DOWNLOAD_URL" || true
fi

# If direct binary not available yet or in dev, install via Deno if present
if [ ! -f "$BINARY_PATH" ] || [ ! -s "$BINARY_PATH" ]; then
  if command -v deno >/dev/null 2>&1; then
    echo "Compiling via local Deno..."
    deno install -g -A -f --config https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/deno.json -n rail https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/cli/main.ts
    exit 0
  else
    echo "Creating bootstrap runner..."
    cat << 'EOF' > "$BINARY_PATH"
#!/bin/sh
exec deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/cli/main.ts "$@"
EOF
  fi
fi

chmod +x "$BINARY_PATH"

echo "✓ Successfully installed RailFog CLI to $BINARY_PATH"

# Check if on PATH
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "Notice: $INSTALL_DIR is not in your PATH."
    echo "Add the following line to your shell profile (~/.bashrc, ~/.zshrc, or ~/.profile):"
    echo ""
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    ;;
esac

echo "Run 'rail --help' or 'rail login' to get started!"
