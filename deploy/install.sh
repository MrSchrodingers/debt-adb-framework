#!/bin/bash
set -euo pipefail

INSTALL_DIR="/opt/dispatch"
SERVICE_NAME="dispatch"

echo "=== Dispatch ADB Framework — Installation ==="

# Create dispatch user if needed
if ! id -u dispatch &>/dev/null; then
  echo "Creating dispatch user..."
  sudo useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin dispatch
fi

# Create directories
echo "Creating directories..."
sudo mkdir -p "$INSTALL_DIR"/{data,logs}
sudo chown -R dispatch:dispatch "$INSTALL_DIR"

# Copy service file
echo "Installing systemd service..."
sudo cp "$(dirname "$0")/dispatch.service" /etc/systemd/system/${SERVICE_NAME}.service
sudo systemctl daemon-reload

# Copy env example if .env doesn't exist
if [ ! -f "$INSTALL_DIR/.env" ]; then
  echo "Creating .env from example (edit before starting)..."
  sudo cp "$(dirname "$0")/dispatch.env.example" "$INSTALL_DIR/.env"
  sudo chown dispatch:dispatch "$INSTALL_DIR/.env"
  sudo chmod 600 "$INSTALL_DIR/.env"
fi

# Enable service
echo "Enabling service..."
sudo systemctl enable ${SERVICE_NAME}

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit /opt/dispatch/.env with your configuration"
echo "  2. Copy the built application to /opt/dispatch/"
echo "  3. Start: sudo systemctl start dispatch"
echo "  4. Check: sudo systemctl status dispatch"
echo "  5. Logs:  sudo journalctl -u dispatch -f"
