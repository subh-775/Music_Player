# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# Audio effects reach the playback session by reflection, because RNTP keeps
# `MusicService.player` private and KotlinAudio keeps `exoPlayer` protected.
# Without these, R8 renames the very fields PlaybackSession looks up by name
# and the equalizer silently stops working in release builds only.
-keepclassmembers class com.doublesymmetry.trackplayer.service.MusicService {
    private *** player;
}
-keepclassmembers class com.doublesymmetry.trackplayer.service.MusicService$MusicBinder {
    *** service;
}
-keepclassmembers class com.doublesymmetry.kotlinaudio.players.** {
    protected *** exoPlayer;
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
