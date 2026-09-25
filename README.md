<div align="center">

<img src="docs/public/logo.png" alt="" width="96" height="96">

# Relaxify

A music player for Android. Search, stream and download from three catalogues
in one place.

[![Release](https://img.shields.io/github/v/release/subh-775/Relaxify?label=Release&labelColor=102514&color=1DB954)](https://github.com/subh-775/Relaxify/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/subh-775/Relaxify/build-android.yml?event=push&label=Build&labelColor=102514&color=1DB954)](https://github.com/subh-775/Relaxify/actions/workflows/build-android.yml)
[![App Docs](https://img.shields.io/badge/App%20Docs-Read-1DB954?labelColor=102514&color=1DB954)](https://subh-775.github.io/Relaxify/)
[![Downloads](https://img.shields.io/github/downloads/subh-775/Relaxify/total?label=Downloads&labelColor=102514&color=1DB954)](https://github.com/subh-775/Relaxify/releases)
[![Licence](https://img.shields.io/github/license/subh-775/Relaxify?label=Licence&labelColor=102514&color=1DB954)](LICENSE)

</div>

---

## About

Relaxify is a music player for everyday listening. One search covers JioSaavn,
SoundCloud and YouTube, and the results arrive as a single list rather than
three you have to compare.

Features:

- **Search across three catalogues at once.** A track available on more than one
  source is listed once, with the others held as fallbacks, so a stream that
  fails switches source instead of returning an error.
- **A full player**, built for one-handed use: swipe the artwork to change
  track, double-tap to seek, and pull up from the bottom for the queue.
- **Queue and autoplay.** Reorder what is coming, play next, add to queue, and
  keep listening when the queue runs out.
- **Downloads for offline listening.** Ordinary tagged audio files, written to a
  folder you choose, that play in any other application.
- **Playlists and a library** of your own — liked tracks, followed artists,
  saved albums and listening history.
- **Import from Spotify.** Any public playlist or album address becomes a
  playlist you own, matched against the three sources track by track.
- **Sound shaping.** An eight-band equalizer with presets, volume
  normalization, and crossfade between tracks.
- **Lyrics**, where the source provides them.
- **Updates in place**, from within the app, with your library untouched.

## Building from source

```bash
git clone https://github.com/subh-775/Relaxify.git
cd Relaxify
npm install
npx react-native run-android
```

Requires the Android SDK and a JDK. The Python engine is bundled by the Gradle
build; nothing needs to be installed for it separately.

## Contributing

Contributions are welcome.

1. Fork the repository and create a feature branch.
2. Set up the development environment (see [Building from source](#building-from-source)).
3. Make the change, keeping to the style of the surrounding code.
4. Run `npx tsc --noEmit`, `npx eslint src/ App.tsx __tests__/` and `npx jest`
   before committing. All three must be clean.
5. Open a pull request describing the change and why it is needed.

## Repository layout

| | |
| --- | --- |
| `App.tsx`, `src/` | The React Native app. `src/screens/` and `src/components/` are the UI; the modules directly under `src/` are the domain — playback, storage, the backend client, the library stores. |
| `android/` | The Android project, the Kotlin native modules, and the embedded Python engine under `android/app/src/main/python/`. |
| `__tests__/` | Jest. Deliberately small: one suite per piece of logic where a mistake would be silent rather than loud. |
| `docs/` | The documentation site (Vite + MDX) published to GitHub Pages from `main`. |

## Disclaimer

The project does not host, store or distribute any copyrighted content.

Users are responsible for ensuring their use complies with applicable law and
with the terms of service of the third-party platforms involved.

The developers assume no liability for misuse of this software.

Support the artists you love: buy their music, and use official streaming
services.

## Licence

[GNU General Public License v3.0](LICENSE). For educational and personal use.
