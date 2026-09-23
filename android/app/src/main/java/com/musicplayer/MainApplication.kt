package com.musicplayer

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.soloader.SoLoader

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Exposes the embedded backend's port to JS (NativeModules.Backend).
              add(BackendPackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, false)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
    // Android's own transparent cache for HttpURLConnection, which is what
    // AudioModule.artworkColor() uses to fetch a cover for Palette. Without it
    // that fetch re-downloaded the same image on every track change AND on
    // every launch — a second copy of a picture Fresco already has, competing
    // for a slow link with the audio stream trying to start. Ten megabytes of
    // 150x150 covers is thousands of songs.
    //
    // Best-effort: a device with no writable cache dir just goes on as before.
    try {
      android.net.http.HttpResponseCache.install(
          java.io.File(cacheDir, "http"), 10L * 1024 * 1024)
    } catch (e: Exception) {
      // no cache — correct, just slower
    }

    // Boot the embedded Python/Flask backend on its own thread. The RN UI reaches
    // it at http://127.0.0.1:BuildConfig.BACKEND_PORT.
    PythonBackend.start(this, BuildConfig.BACKEND_PORT)
  }
}
