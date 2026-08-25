/**
 * @format
 */

// MUST be the very first import in the app: gesture-handler patches the touch
// system at load time, and anything that renders before it misses the patch.
import 'react-native-gesture-handler';
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
