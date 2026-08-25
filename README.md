# Music Player

React Native (Android) music client. The UI is native RN; the search / stream /
download backend is the embedded Python (Flask via Chaquopy) engine, reached at
`http://127.0.0.1:<port>`.

**Documentation:** <https://subh-775.github.io/Music_Player/> — built from
`docs/` (Vite + React) and deployed by `.github/workflows/docs.yml` on any push
to `mobile` that touches it. This is what the app's **Help** entry opens.

## Build

- **Debug APK** (for on-device testing with live reload): Actions → *Build
  Android APK* → Run workflow → `debug`. Install the artifact, then run Metro on
  the PC and `adb reverse tcp:8081 tcp:8081` to load JS live.
- **Release APK**: push a `v*` tag.

Backend ports: release `8770`, debug `8771`.
