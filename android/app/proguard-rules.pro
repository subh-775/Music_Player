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
