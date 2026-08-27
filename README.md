<div align="center">

<img src="docs/public/logo.png" alt="" width="96" height="96">

# Fix_Music

An Android music client that searches JioSaavn, SoundCloud and YouTube as one
catalogue, streams from whichever source has the track, and keeps a real file on
the device when asked.

[![Release](https://img.shields.io/github/v/release/subh-775/Music_Player?label=Release&labelColor=161F34&color=7FC8FF)](https://github.com/subh-775/Music_Player/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/subh-775/Music_Player/build-android.yml?label=Build&labelColor=161F34&color=7FC8FF)](https://github.com/subh-775/Music_Player/actions/workflows/build-android.yml)
[![App Docs](https://img.shields.io/badge/App%20Docs-Read-161F34?labelColor=161F34&color=7FC8FF)](https://subh-775.github.io/Music_Player/)
[![Downloads](https://img.shields.io/github/downloads/subh-775/Music_Player/total?label=Downloads&labelColor=161F34&color=7FC8FF)](https://github.com/subh-775/Music_Player/releases)
[![Licence](https://img.shields.io/github/license/subh-775/Music_Player?label=Licence&labelColor=161F34&color=7FC8FF)](LICENSE)

[Documentation](https://subh-775.github.io/Music_Player/) ·
[Install](https://subh-775.github.io/Music_Player/guide/installation) ·
[Latest release](https://github.com/subh-775/Music_Player/releases/latest) ·
[Report a problem](https://github.com/subh-775/Music_Player/issues)

</div>

---

## Overview

A track available on more than one source is listed once; the remaining sources
are retained as fallbacks, so a stream that fails switches source rather than
returning an error. Search, ranking, stream resolution and downloading all run
on the device.

| | |
| --- | --- |
| **Platform** | Android, `arm64-v8a` |
| **Interface** | React Native 0.75.4, Hermes, native views |
| **Engine** | Embedded Python (Flask via Chaquopy), loopback only |
| **Playback** | ExoPlayer through a foreground service |
| **Distribution** | GitHub Releases; the app updates itself in place |

Backend ports: release `8770`, debug `8771`.

## Documentation

<https://subh-775.github.io/Music_Player/> — every gesture, setting and feature,
and the page the app's **Help** entry opens.

Built from `docs/` (Vite, React, MDX) and published by
`.github/workflows/docs.yml`. It deploys from **`main`** only: the `github-pages`
environment permits the default branch and nothing else, so a docs change has to
be merged before it goes live.

## Build

| Target | How |
| --- | --- |
| **Release** | Push a `v*` tag. CI builds the APK, derives `versionName` and `versionCode` from the tag, and attaches the artifact to a GitHub Release. |
| **Debug** | Actions → *Build Android APK* → Run workflow → `debug`. Install the artifact, run Metro on the host, then `adb reverse tcp:8081 tcp:8081` for live reload. |

The version is never written into a file by hand. It is derived from the tag, so
the number shown under **Settings → App version** cannot drift from the build it
came from.

## Licence

[GNU General Public License v3.0](LICENSE). For educational and personal use.
Not affiliated with, endorsed by, or connected to Spotify, JioSaavn, SoundCloud
or YouTube.
