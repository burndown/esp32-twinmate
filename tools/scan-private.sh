#!/bin/sh
# Looks for private data in everything git tracks: LAN addresses, local paths, user names, SDK tokens, gateway tokens in URLs,
# WireGuard private keys, PEM keys and MAC addresses. Exits 1 and prints the lines if anything matches.
# Run it before every push: tools/scan-private.sh
cd "$(dirname "$0")/.." || exit 2
PATTERNS='192\.168\.[0-9]+\.[0-9]+|/Users/[A-Za-z0-9._-]+|/home/heigao|heigao|mgst_[A-Za-z0-9_-]{43}|[?&]k=[0-9a-fA-F]{24,}|PrivateKey[[:space:]]*=[[:space:]]*[A-Za-z0-9+/]{43}=|BEGIN [A-Z ]*PRIVATE KEY|([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}'
hits=$(git ls-files -z | xargs -0 grep -nIE "$PATTERNS" 2>/dev/null | grep -v '^tools/scan-private.sh:' | cut -c1-200)
if [ -n "$hits" ]; then
  echo "Private-looking data found:"; echo "$hits"; exit 1
fi
echo "scan-private: clean"
