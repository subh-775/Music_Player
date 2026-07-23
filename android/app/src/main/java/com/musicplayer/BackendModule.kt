package com.musicplayer

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/**
 * Hands the backend port to JS as a constant, so the RN side never hardcodes it
 * and debug (8771) vs release (8770) is picked automatically from BuildConfig.
 *   import { NativeModules } from 'react-native';
 *   const base = `http://127.0.0.1:${NativeModules.Backend.port}`;
 */
class BackendModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "Backend"

    override fun getConstants(): Map<String, Any> =
        mapOf("port" to BuildConfig.BACKEND_PORT)
}
