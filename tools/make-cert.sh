#!/usr/bin/env bash
#
# Generate the HTTPS certificate the /face route needs.
#
# Phone browsers hand out the microphone and camera only in a secure context,
# and a LAN address over plain http:// is not one. This mints a certificate for
# whatever IP this laptop currently has, signed by the local mkcert CA, and
# drops the CA's public half into certs/ so the server can offer it to a phone
# at http://<laptop>:3000/rootCA.pem
#
# Re-run it whenever the laptop's IP changes — the certificate is pinned to the
# addresses baked in at creation time.
#
# Usage:  npm run cert            (from backend/)
#         tools/make-cert.sh      (from the project root)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT/certs"

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert is not installed."
  echo "  brew install mkcert"
  exit 1
fi

# Every IPv4 address this machine currently answers on, so the certificate
# keeps working across a WiFi switch or a docking station.
IPS=$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.' || true)

if [ -z "$IPS" ]; then
  echo "No non-loopback IPv4 address found — is the WiFi up?"
  exit 1
fi

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

echo "Minting a certificate for:"
for ip in $IPS; do echo "  $ip"; done
echo "  localhost / 127.0.0.1"
echo

# shellcheck disable=SC2086
mkcert -cert-file lan-cert.pem -key-file lan-key.pem $IPS localhost 127.0.0.1 ::1

# The CA's public certificate, for installing on the phone. The matching
# private key stays in mkcert's own directory and is never copied here.
CAROOT="$(mkcert -CAROOT)"
if [ -f "$CAROOT/rootCA.pem" ]; then
  cp "$CAROOT/rootCA.pem" "$CERT_DIR/rootCA.pem"
  echo
  echo "Copied the root CA to certs/rootCA.pem"
fi

echo
echo "Done. Restart the server, then on the phone:"
echo "  1. open  http://<laptop-ip>:3000/rootCA.pem  and install it"
echo "     Android: Settings > Security > More security settings >"
echo "              Encryption & credentials > Install a certificate > CA certificate"
echo "  2. open  https://<laptop-ip>:3443/face"
