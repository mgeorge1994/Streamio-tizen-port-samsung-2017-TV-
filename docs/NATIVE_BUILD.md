# Stremio Native — on-device torrent edition (red tile)

This is a **separate app** from the working bridge edition. It keeps the exact
same UI, but adds an on-device NaCl torrent engine so torrents play from
`http://127.0.0.1:11470` on the TV itself, with no laptop/external device.

- Current/working app: `app/` → package `stremiotv1.stremio`, tile unchanged, uses `192.168.0.136:11470`
- Native edition: `app-native/` → package `stremiotv2.stremio`, **red-bordered wide tile**, uses `127.0.0.1:11470`

The red border is on the 1920×1080 launcher tile (`app-native/icon.png`).

## Built package

`~/stremio-tizen-port/signed/StremioNative.wgt` — version `1.0.2`, signed with `tvLauncher`.

**v1.0.2 fix:** the UDP tracker announce request was 88 bytes instead of the
98 bytes required by BEP 15 (`downloaded`/`left`/`uploaded` were sent as 4-byte
values instead of 8-byte, and the port as 4 bytes instead of 2). Trackers
silently ignored it, so peer discovery always returned 0. Verified from the
host: a correct 98-byte announce gets a peer list reply, the old 88-byte one
gets no reply. Also replaced dead/stale tracker IPs with ones verified to
answer, added an explicit UDP `bind()`, checked `SO_ERROR` after non-blocking
TCP connects, and added diagnostic counters (`announceOk`, `announceFail`,
`found`, `connOk`, `connFail`) to `/stats/{hash}`.

Do **not** install until asked. When the TV is available:

```
~/tizen-studio/tools/ide/bin/tizen install -n ~/stremio-tizen-port/signed/StremioNative.wgt -t UE50MU6102
~/tizen-studio/tools/ide/bin/tizen run -p stremiotv2.stremio -t UE50MU6102
```

It can coexist with the current app because the package ID is different.

## What the native engine does

`app-native/nacl/` contains:

- `src/torrent_engine.cc` — UDP trackers (BEP 15), peer-wire, ut_metadata,
  SHA-1 piece verification, sliding piece cache, and a local HTTP server with
  Range/206 support on port 11470.
- `src/engine_instance.cc` — PPAPI bridge; calls `nacl_io_init_ppapi()` so the
  C++ code gets POSIX TCP/UDP sockets and threads.
- `stremio_engine.nmf` + `stremio_engine_arm.nexe` (TV) and
  `stremio_engine_x86_32.nexe` (emulator) — loaded by the widget via
  `<embed type="application/x-nacl" src="nacl/stremio_engine.nmf">`.
- `js/engine.js` — posts `start`/`stop`/`stats` messages to the module.

`js/app.js` starts the engine when a torrent stream is selected; `js/api.js`
defaults `streamServer` to `http://127.0.0.1:11470`.

## Rebuilding

The Samsung Pepper 63 SDK is at `nacl-toolchain/pepper_63`. The SDK's Python 2
helper scripts were patched to run under Python 3, and a `python` → `python3`
shim is at `nacl-toolchain/bin/python`. Build under Rosetta:

```
cd ~/stremio-tizen-port/app-native/nacl
PATH=~/stremio-tizen-port/nacl-toolchain/bin:$PATH \
  /usr/bin/arch -x86_64 /usr/bin/make TOOLCHAIN=pnacl CONFIG=Release -j4
```

Translate and strip:

```
TB=~/stremio-tizen-port/nacl-toolchain/pepper_63/toolchain/mac_pnacl/bin
/usr/bin/arch -x86_64 "$TB/pnacl-translate" -arch armv7 pnacl/Release/stremio_engine.pexe -o stremio_engine_arm.nexe
/usr/bin/arch -x86_64 "$TB/pnacl-translate" -arch i686 pnacl/Release/stremio_engine.pexe -o stremio_engine_x86_32.nexe
/usr/bin/arch -x86_64 "$TB/arm-nacl-strip" stremio_engine_arm.nexe -o stremio_engine_arm_stripped.nexe
/usr/bin/arch -x86_64 "$TB/i686-nacl-strip" stremio_engine_x86_32.nexe -o stremio_engine_x86_32_stripped.nexe
mv stremio_engine_arm_stripped.nexe stremio_engine_arm.nexe
mv stremio_engine_x86_32_stripped.nexe stremio_engine_x86_32.nexe
rm -rf pnacl
```

Then package:

```
cd ~/stremio-tizen-port/app-native
~/tizen-studio/tools/ide/bin/tizen package -t wgt -s tvLauncher -o ../signed
cd ../signed && cp "Stremio Native.wgt" StremioNative.wgt
```

## Status

Built and signed successfully. **Not yet tested on the TV.** The first TV run
should verify:

1. The NaCl module loads (`engine.js` receives `{"event":"init","ok":true}`).
2. A TCP server can bind `127.0.0.1:11470` and the widget's `<video>` can read it.
3. UDP tracker announces work (Samsung NaCl socket permissions/architecture).

If NaCl sockets are blocked on this firmware, this build will still install;
torrent playback simply won't start. The bridge edition remains the fallback.
