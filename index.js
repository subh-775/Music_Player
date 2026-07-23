/**
 * @format
 */

import {AppRegistry} from 'react-native';
import TrackPlayer from 'react-native-track-player';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);

// The playback service runs in the foreground service, outside the UI — it is
// what receives lock-screen and Bluetooth/earbud transport commands. Registering
// it is required by react-native-track-player, and must happen at startup.
// Guarded so an older APK without the native engine still boots the UI.
try {
  TrackPlayer.registerPlaybackService(() => require('./src/playbackService'));
} catch {
  /* no native audio engine in this build — UI still runs */
}
