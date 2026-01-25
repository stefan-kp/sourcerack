#!/bin/sh
# SourceRack Installation Script
#
# Quick install:
#   curl -sSL https://sourcerack.dev/install.sh | sh
#
# Or via npm (requires Node.js 20+):
#   npm install -g sourcerack
#
# Environment variables:
#   INSTALL_DIR - Custom installation directory (default: /usr/local/bin)
#   VERSION     - Specific version to install (default: latest)
#   USE_NPM     - Set to "1" to install via npm instead of binary

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# GitHub repository
REPO="your-org/sourcerack"
BINARY_NAME="sourcerack"

# Default installation directory
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Print colored output
info() {
    printf "${BLUE}[INFO]${NC} %s\n" "$1"
}

success() {
    printf "${GREEN}[OK]${NC} %s\n" "$1"
}

warn() {
    printf "${YELLOW}[WARN]${NC} %s\n" "$1"
}

error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1" >&2
    exit 1
}

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Linux*)  OS="linux" ;;
        Darwin*) OS="darwin" ;;
        CYGWIN*|MINGW*|MSYS*) OS="windows" ;;
        *)       error "Unsupported operating system: $(uname -s)" ;;
    esac
    echo "$OS"
}

# Detect architecture
detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)  ARCH="x64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *)             error "Unsupported architecture: $(uname -m)" ;;
    esac
    echo "$ARCH"
}

# Get latest version from GitHub API
get_latest_version() {
    if command -v curl >/dev/null 2>&1; then
        VERSION=$(curl -sSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    elif command -v wget >/dev/null 2>&1; then
        VERSION=$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    else
        error "Neither curl nor wget found. Please install one of them."
    fi

    if [ -z "$VERSION" ]; then
        error "Could not determine latest version"
    fi

    echo "$VERSION"
}

# Check for required commands
check_dependencies() {
    # Check for download tool
    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        error "Neither curl nor wget found. Please install one of them."
    fi

    # Check for tar (needed for extraction)
    if ! command -v tar >/dev/null 2>&1; then
        error "tar not found. Please install tar."
    fi
}

# Download file
download() {
    URL="$1"
    OUTPUT="$2"

    if command -v curl >/dev/null 2>&1; then
        curl -sSL "$URL" -o "$OUTPUT"
    else
        wget -q "$URL" -O "$OUTPUT"
    fi
}

# Main installation
main() {
    echo ""
    echo "  ╔═══════════════════════════════════════╗"
    echo "  ║     SourceRack Installer              ║"
    echo "  ║     Semantic Code Intelligence        ║"
    echo "  ╚═══════════════════════════════════════╝"
    echo ""

    check_dependencies

    OS=$(detect_os)
    ARCH=$(detect_arch)

    info "Detected: ${OS}/${ARCH}"

    # Get version (from env or latest)
    if [ -z "$VERSION" ]; then
        info "Fetching latest version..."
        VERSION=$(get_latest_version)
    fi

    info "Installing SourceRack ${VERSION}..."

    # Construct download URL
    # Format: sourcerack-{version}-{os}-{arch}.tar.gz
    ARCHIVE_NAME="${BINARY_NAME}-${VERSION}-${OS}-${ARCH}.tar.gz"
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARCHIVE_NAME}"

    # Create temp directory
    TMP_DIR=$(mktemp -d)
    trap "rm -rf $TMP_DIR" EXIT

    # Download archive
    info "Downloading from ${DOWNLOAD_URL}..."
    download "$DOWNLOAD_URL" "$TMP_DIR/$ARCHIVE_NAME" || error "Download failed. Check if the release exists for your platform."

    # Extract archive
    info "Extracting..."
    tar -xzf "$TMP_DIR/$ARCHIVE_NAME" -C "$TMP_DIR"

    # Find the binary
    BINARY_PATH=$(find "$TMP_DIR" -name "$BINARY_NAME" -type f | head -1)
    if [ -z "$BINARY_PATH" ]; then
        error "Binary not found in archive"
    fi

    # Make executable
    chmod +x "$BINARY_PATH"

    # Install binary
    info "Installing to ${INSTALL_DIR}..."

    # Check if we need sudo
    if [ -w "$INSTALL_DIR" ]; then
        mv "$BINARY_PATH" "$INSTALL_DIR/$BINARY_NAME"
    else
        warn "Elevated permissions required for ${INSTALL_DIR}"
        sudo mv "$BINARY_PATH" "$INSTALL_DIR/$BINARY_NAME"
    fi

    # Verify installation
    if command -v "$BINARY_NAME" >/dev/null 2>&1; then
        INSTALLED_VERSION=$("$BINARY_NAME" --version 2>/dev/null || echo "unknown")
        success "SourceRack installed successfully!"
        echo ""
        echo "  Version: ${INSTALLED_VERSION}"
        echo "  Location: ${INSTALL_DIR}/${BINARY_NAME}"
    else
        warn "Installation complete, but '$BINARY_NAME' not in PATH"
        echo ""
        echo "  Add ${INSTALL_DIR} to your PATH:"
        echo "    export PATH=\"${INSTALL_DIR}:\$PATH\""
    fi

    show_quickstart
}

# Install via npm (simpler if Node.js is available)
install_via_npm() {
    info "Installing via npm..."

    # Check for npm
    if ! command -v npm >/dev/null 2>&1; then
        error "npm not found. Please install Node.js 20+ first."
    fi

    # Check Node version
    NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -lt 20 ] 2>/dev/null; then
        warn "Node.js 20+ recommended (found: v${NODE_VERSION})"
    fi

    npm install -g sourcerack

    success "SourceRack installed via npm!"
    show_quickstart
}

# Show quick start guide
show_quickstart() {
    echo ""
    echo "  ${GREEN}Quick Start:${NC}"
    echo "    cd your-project"
    echo "    sourcerack index .               # Index your codebase"
    echo "    sourcerack query \"error handling\"   # Search semantically"
    echo "    sourcerack find-def MyClass      # Find symbol definitions"
    echo "    sourcerack call-graph myFunc     # Show call graph"
    echo ""
    echo "  ${BLUE}Documentation:${NC} https://github.com/${REPO}#readme"
    echo ""
}

# Run main
if [ "$USE_NPM" = "1" ] || [ "$1" = "--npm" ]; then
    install_via_npm
else
    main "$@"
fi
