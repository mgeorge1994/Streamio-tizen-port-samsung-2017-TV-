# Installing on a Samsung 2017 TV (Tizen 3.0)

Tested on a UE50MU6102. Other 2017 Tizen 3.0 models should work the same way.

## 1. Put the TV in Developer Mode

1. On the TV, open **Apps**.
2. Press `1 2 3 4 5` on the remote (or type it in the Apps search field).
3. Turn **Developer Mode** on and set **Host PC IP** to your computer's IP.
4. Reboot the TV.

## 2. Tizen Studio + certificate

1. Install **Tizen Studio** with the **TV 3.0** extension.
2. In Certificate Manager create a **Samsung** certificate profile (the scripts use the name `tvLauncher`; change `-s tvLauncher` in `tools/deploy.sh` if yours differs) and add your TV's DUID.

An unsigned widget fails with `install failed[118]`, so signing is required.

## 3. Build, install and launch

```bash
TV_IP=<your tv ip> TV_NAME=<tv model as shown by `sdb devices`> bash tools/deploy.sh
```

The script connects with `sdb`, rebuilds the PNaCl torrent engine (needs the NaCl SDK `pepper_63` in `nacl-toolchain/`, see `NATIVE_BUILD.md`), packages and signs `app-native/`, installs it and launches it.

No NaCl SDK? The prebuilt engine (`app-native/nacl/*.nexe`) is in the repo, so you can skip the build step and just package/install:

```bash
cd app-native
tizen package -t wgt -s tvLauncher -o ../signed
tizen install -n "../signed/Stremio Native.wgt" -t <tv model>
tizen run -p stremiotv2.stremio -t <tv model>
```

## 4. Using the app

- Arrows move focus, **OK** selects, **Back** returns.
- Sign in with your Stremio account to sync your library, Continue Watching and addons, or use the default Cinemeta catalogs.
- Torrent streams play directly on the TV through the built-in engine (`127.0.0.1:11470`).
- *Settings → Movie info* adds Rotten Tomatoes / Metascore / budget etc. with your own free OMDb and/or TMDB keys.
