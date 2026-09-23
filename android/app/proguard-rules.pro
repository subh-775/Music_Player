# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# ── Reflection surface: the equalizer, the loudness enhancer and the volume
# fade all reach ExoPlayer through RNTP/KotlinAudio privates, BY NAME. Anything
# R8 renames, removes or inlines here fails only at runtime, only in release,
# and only as "the effect silently does nothing" — so these are kept whole
# rather than surgically. The classes are small; the debugging cost is not.
-keep class com.doublesymmetry.trackplayer.** { *; }
-keep class com.doublesymmetry.kotlinaudio.** { *; }
-dontwarn com.doublesymmetry.**

# ExoPlayer / media3 itself: keep the player types and their members intact so
# getAudioSessionId / setVolume / getVolume still resolve reflectively, and so
# the optimizer cannot merge the class hierarchy the field walk relies on.
-keep class com.google.android.exoplayer2.** { *; }
-keep interface com.google.android.exoplayer2.** { *; }
-keep class androidx.media3.** { *; }
-keep interface androidx.media3.** { *; }
-dontwarn com.google.android.exoplayer2.**
-dontwarn androidx.media3.**

# Never rename the members we look up by string, wherever they ended up.
-keepclassmembernames class * {
    *** exoPlayer;
    *** player;
}

# AudioModule drives the player's volume by reflection (the background-safe
# fade — see the note there). getAudioSessionId/setVolume/getVolume are looked
# up BY NAME on the ExoPlayer instance, so R8 must not rename or strip them, or
# every fade silently no-ops in release only.
-keepclassmembers class * implements com.google.android.exoplayer2.Player {
    public int getAudioSessionId();
    public void setVolume(float);
    public float getVolume();
}
-keepclassmembers class * implements androidx.media3.common.Player {
    public int getAudioSessionId();
    public void setVolume(float);
    public float getVolume();
}

# Our own code is tiny; keep it whole so the native modules and every
# @ReactMethod resolve by name from JS. Nothing to gain shrinking it, and one
# renamed bridge method is a release-only crash.
-keep class com.musicplayer.** { *; }

# NewPipeExtractor solves YouTube's signature challenge by running its JS in
# Mozilla Rhino, which is all reflection. R8 renaming any of it breaks YouTube
# in release only. nanojson is NewPipe's runtime JSON parser.
-keep class org.schabi.newpipe.extractor.** { *; }
-keep class org.mozilla.javascript.** { *; }
-keep class org.mozilla.classfile.** { *; }
-keep class com.grack.nanojson.** { *; }
-dontwarn org.schabi.newpipe.extractor.**
-dontwarn org.mozilla.javascript.**

# Chaquopy loads CPython and marshals Java<->Python by reflection.
-keep class com.chaquo.python.** { *; }
-dontwarn com.chaquo.python.**

# Reflection and generic signatures the above rely on.
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# Reanimated and gesture-handler (the queue's drag). Both ship their own
# consumer rules, but their native<->JS bridges are reflective and minify is on
# here, so keep them whole rather than discover a release-only breakage.
-keep class com.swmansion.reanimated.** { *; }
-keep class com.swmansion.gesturehandler.** { *; }
-keep class com.facebook.jni.** { *; }
-dontwarn com.swmansion.**
