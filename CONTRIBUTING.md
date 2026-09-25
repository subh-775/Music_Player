# Contributing to Relaxify

Thank you for helping. This guide covers how the code is organised, how to
propose a change, and the few rules that keep existing installs updating
safely.

## Workflow

The repository has two long-lived branches:

| Branch | Role |
| --- | --- |
| `mobile` | Development. All work lands here, and releases are tagged from here. |
| `main` | Published. The documentation site is deployed from it. |

To contribute:

1. Fork the repository.
2. Create a branch from `mobile`, named for the change: `feature/queue-search`,
   `fix/crossfade-gap`, `docs/equalizer-page`.
3. Make one focused change per branch. A feature and an unrelated fix belong in
   separate pull requests.
4. Run the checks below until they pass.
5. Open a pull request **into `mobile`**. Describe what changed, why, and how
   you tested it on a device.

The maintainer merges into `mobile`, tags releases, and merges `mobile` into
`main` to publish the documentation.

## Checks

Run all of these before opening a pull request. Continuous integration runs the
first three on every release tag, and a failure stops the release.

```bash
npx tsc --noEmit
npx eslint src/ App.tsx __tests__/
npx jest
```

If you changed Python under `android/app/src/main/python/`:

```bash
python -m py_compile path/to/changed_file.py
```

Kotlin changes compile in the Android build. If you have no local Android SDK,
push a test tag (see [Testing on a device](#testing-on-a-device)); when the
Kotlin build fails, the compiler error appears as an annotation on the workflow
run.

Add a test in `__tests__/` when your change contains logic where a mistake
would be silent: ordering, matching, parsing, version comparison and similar.

## Where things live

### Interface: `App.tsx` and `src/`

| Path | Purpose |
| --- | --- |
| `index.js` | Entry point. Registers the app and the background playback service. |
| `App.tsx` | The shell: tabs, overlays, the mini player, the full player and the sheets. |
| `src/screens/` | One file per screen: Home, Search, Library, Player, Queue, Settings and so on. |
| `src/components/` | Shared pieces: rows, sheets, the mini player (`PlayerBar.tsx`), the seekbar. |
| `src/player.ts` | Playback: building and editing the queue, skipping, shuffle, Autoplay and resume. |
| `src/playbackService.ts` | Lock-screen, notification and headset controls. |
| `src/playerSheet.ts` | The geometry of the mini player to full player transition. |
| `src/backend.ts` | The client for the embedded engine, and the shared data types. |
| `src/store.ts`, `src/storage.ts` | Settings, likes and other saved state. |
| `src/audioEffects.ts`, `src/eq.ts` | The bridge to the native equalizer, loudness and crossfade. |
| `src/downloads.ts`, `src/update.ts` | Downloads, and the in-app updater. |
| `src/theme.ts`, `src/font.ts` | Colours, type and the app-wide font. |

### Native: `android/app/src/main/java/com/musicplayer/`

| File | Purpose |
| --- | --- |
| `MainApplication.kt`, `PythonBackend.kt` | Start the embedded Python engine. |
| `BackendModule.kt` | Hands the engine's port and token to the app; folder picker; engine restart. |
| `AudioModule.kt` | Equalizer, loudness, crossfade, volume ramps and artwork colours. |
| `UpdateModule.kt` | Checks GitHub Releases and installs updates. |
| `PlaybackSession.kt`, `MusicServiceRef.kt` | Reach the playback service's audio session for effects. |
| `YouTubeNP.kt` | YouTube stream resolution through NewPipeExtractor. |

### Engine: `android/app/src/main/python/`

| Path | Purpose |
| --- | --- |
| `mobile_server.py` | The HTTP API the app calls: search, streams, lyrics, downloads, library. |
| `components/unified_search.py`, `source_merger.py`, `fuzzy_matcher.py` | Searching the three sources and merging matching results. |
| `components/radio.py` | Autoplay: similar songs from Last.fm, resolved to playable sources. |
| `components/*_downloader.py`, `download_manager.py` | Resolving streams and downloading from each source. |

### Other

| Path | Purpose |
| --- | --- |
| `patches/` | Fixes to third-party libraries, applied automatically by `npm install`. Re-check them when you upgrade a patched library. |
| `docs/` | The documentation site. Pages are MDX files in `docs/content/`. |
| `.github/workflows/` | The Android build and release workflow, and the documentation deployment. |

## Code style

- TypeScript for all app code. Prettier and ESLint settings are in the
  repository; run them before committing.
- Match the surrounding code. Comments explain **why** something is done a
  certain way, especially where the obvious approach was tried and failed.
- Keep work off the JavaScript thread during animations and gestures. Anything
  that moves under a finger should be driven by Reanimated shared values, not
  React state.
- Prefer the code already in the repository over new dependencies. A new
  dependency adds to the size of every install, so it needs a clear reason in
  the pull request.

## Rules that protect existing installs

Breaking any of these would stop users receiving updates or cost them their
data.

1. **Never change the application id** (`com.musicplayer`) or the signing
   keystore (`android/app/debug.keystore`). Android only installs an update over
   an app with the same id and the same signature. Anything else installs as a
   different app, and users lose their library when they switch.
2. **Never edit `versionName` or `versionCode` by hand.** The release workflow
   derives both from the tag: `v1.2.16` becomes version `1.2.16`, code `10216`.
3. **Keep the backend ports distinct:** release `8770`, debug `8771`, test
   builds `8772`. Two variants on one phone must never share a port.
4. **Never install a test build under the real application id.** Use the test
   build described below.

## Testing on a device

- **Day to day:** the debug build with Fast Refresh. See
  [DEVELOPING.md](DEVELOPING.md).
- **A release-quality build, on a real phone:** push a tag like
  `v1.2.17-rc1`. The workflow builds **Relaxify RC** (`com.musicplayer.rc`), a
  separate app with its own name, icon, storage, download folder and port. It
  installs next to the real app and cannot replace it or read its data. It is
  published as a GitHub pre-release, which the real app's updater never offers.

## Releases

Releases are made by the maintainer:

1. Merge the finished work into `mobile`.
2. Push the next `vX.Y.Z` tag on `mobile`. The workflow builds `Relaxify.apk`,
   runs the checks, and publishes a GitHub Release.
3. Installed apps find the release through the in-app updater.
4. Merge `mobile` into `main` when the documentation changed.

## Licence

By contributing, you agree that your contribution is licensed under the
[GNU General Public License v3.0](LICENSE), like the rest of the project.
