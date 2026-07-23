package com.musicplayer

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/**
 * Hands the backend port and per-launch API token to JS as constants, so the RN
 * side never hardcodes the port (debug 8771 / release 8770, from BuildConfig)
 * and can authenticate every /api call. Constants are available synchronously at
 * bridge init, so the very first fetch already carries the token.
 *   import { NativeModules } from 'react-native';
 *   const { port, token } = NativeModules.Backend;
 */
class BackendModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "Backend"

    override fun getConstants(): Map<String, Any> =
        mapOf(
            "port" to BuildConfig.BACKEND_PORT,
            "token" to PythonBackend.apiToken,
            "version" to (
                reactApplicationContext.packageManager
                    .getPackageInfo(reactApplicationContext.packageName, 0)
                    .versionName ?: ""
            ),
        )
}
