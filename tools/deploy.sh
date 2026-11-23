#!/bin/bash
# Build + package + install + launch Stremio Native (version read from config.xml).
# Run from macOS Terminal:  TV_IP=<tv ip> bash tools/deploy.sh
# Needs Tizen Studio (certificate profile "tvLauncher") and the NaCl SDK
# (pepper_63) under $ROOT/nacl-toolchain -- see docs/NATIVE_BUILD.md.
set -euo pipefail

ROOT=${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
TS=${TIZEN_STUDIO:-$HOME/tizen-studio}
SDB=$TS/tools/sdb
TIZEN=$TS/tools/ide/bin/tizen
TB=$ROOT/nacl-toolchain/pepper_63/toolchain/mac_pnacl/bin
TV_IP=${TV_IP:-192.168.0.235}       # your TV's IP (Developer Mode on)
TV=$TV_IP:26101
VER=$(grep -o 'version="1\.[0-9]*\.[0-9]*"' "$ROOT/app-native/config.xml" | head -1 | tr -cd '0-9')
echo "Version: $VER"
# The PNaCl tools call `python`; nacl-toolchain/bin has a python->python3 shim.
export PATH=$ROOT/nacl-toolchain/bin:$PATH

echo "== 1/6 connect to TV ($TV)"
ping -c 2 -t 3 "$TV_IP" >/dev/null && echo "   ping OK" || echo "   ping FAILED (TV off / asleep?)"
"$SDB" connect "$TV"
"$SDB" devices

echo "== 2/6 build PNaCl engine"
cd "$ROOT/app-native/nacl"
rm -rf pnacl
PATH=$ROOT/nacl-toolchain/bin:$PATH /usr/bin/arch -x86_64 /usr/bin/make TOOLCHAIN=pnacl CONFIG=Release -j4
PEXE=$(find pnacl -name 'stremio_engine.pexe' | head -1)
echo "   pexe: $PEXE"

echo "== 3/6 translate (NO strip -- stripping breaks module load)"
/usr/bin/arch -x86_64 "$TB/pnacl-translate" -arch armv7 "$PEXE" -o stremio_engine_arm.nexe
/usr/bin/arch -x86_64 "$TB/pnacl-translate" -arch i686  "$PEXE" -o stremio_engine_x86_32.nexe
rm -rf pnacl
ls -la *.nexe

echo "== 4/6 package (tvLauncher)"
cd "$ROOT/app-native"
"$TIZEN" package -t wgt -s tvLauncher -o ../signed
cp "$ROOT/signed/Stremio Native.wgt" "$ROOT/signed/StremioNative_v$VER.wgt"

echo "== 5/6 install"
"$TIZEN" install -n "$ROOT/signed/StremioNative_v$VER.wgt" -t "${TV_NAME:-UE50MU6102}"

echo "== 6/6 log receiver + launch"
if ! curl -s -m 2 http://127.0.0.1:8877/health >/dev/null; then
  nohup python3 "$ROOT/tools/tv-log-server.py" >/tmp/tv-log-server.out 2>&1 &
  sleep 1; echo "   log server started (port 8877)"
else
  echo "   log server already running"
fi
"$TIZEN" run -p stremiotv2.stremio -t "${TV_NAME:-UE50MU6102}"

echo
echo "DONE. Press Play on the TV, then run:"
echo "  (TV logs are printed by tools/tv-log-server.py on port 8877)"
