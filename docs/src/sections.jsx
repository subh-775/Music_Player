/**
 * The documentation itself.
 *
 * Written against the code rather than from memory: every number here — the
 * eight EQ bands, the twelve-second crossfade ceiling, the ten-second seek step
 * — is the value the app actually uses, so this page and the build stay in
 * agreement. That is the whole reason the docs live in the app's own repository.
 */
import {useRef} from 'react';
import {
  CrossfadeDemo,
  EqDemo,
  GestureCard,
  SeekDemo,
  stages,
  useAnimationGate,
} from './demos.jsx';

export const RELEASES = 'https://github.com/subh-775/Music_Player/releases/latest';
export const REPO = 'https://github.com/subh-775/Music_Player';

export const SECTIONS = [
  {id: 'overview', label: 'Overview'},
  {id: 'install', label: 'Install'},
  {id: 'player', label: 'The player'},
  {id: 'gestures', label: 'Gestures'},
  {id: 'queue', label: 'The queue'},
  {id: 'search', label: 'Search & sources'},
  {id: 'library', label: 'Library & downloads'},
  {id: 'sound', label: 'Sound'},
  {id: 'settings', label: 'Settings'},
  {id: 'updates', label: 'Updates'},
  {id: 'faq', label: 'Troubleshooting'},
];

/* ── Overview ────────────────────────────────────────────────────────────── */

function Overview() {
  return (
    <section className="sec" id="overview">
      <h2>Overview</h2>
      <p className="kicker">
        Fix_Music is an Android music player that searches three catalogues at
        once, streams from whichever one actually has the track, and keeps a
        copy on your phone when you ask it to. There is no account and nothing
        to sign in to.
      </p>

      <div className="grid">
        <div className="card">
          <div className="ico">♪</div>
          <h4>Three sources, one library</h4>
          <p>
            JioSaavn, SoundCloud and YouTube are searched together and ranked as
            one result list. A track that fails on one source falls through to
            another rather than failing outright.
          </p>
        </div>
        <div className="card">
          <div className="ico">⭳</div>
          <h4>Downloads that stay yours</h4>
          <p>
            Downloaded songs are ordinary files in a folder you choose, with
            artwork and tags written in. They play with no connection and
            survive the app being uninstalled.
          </p>
        </div>
        <div className="card">
          <div className="ico">⇄</div>
          <h4>Built for the thumb</h4>
          <p>
            Every common action has a gesture: swipe the artwork to change song,
            pull up for the queue, drag down to put the player away, swipe in
            from the edge for the drawer.
          </p>
        </div>
        <div className="card">
          <div className="ico">≡</div>
          <h4>Sound you can shape</h4>
          <p>
            An eight-band equalizer mapped onto whatever your device really has,
            volume normalization, crossfade up to twelve seconds, and a sleep
            timer that survives the screen going off.
          </p>
        </div>
      </div>

      <h3>How it works</h3>
      <p>
        The interface is native Android. Behind it, the app runs its own search
        and download engine <em>on the phone</em> — a Python service bound to{' '}
        <code>127.0.0.1</code> that nothing outside the device can reach. There
        is no server of ours in the path: your searches, your library and your
        listening history never leave the handset.
      </p>

      <div className="note">
        <b>Android only.</b> The app is built against Android 7.0 and newer.
        There is no iOS build and there will not be one — the playback engine,
        the audio effects and the download folder all use APIs that have no
        equivalent there.
      </div>
    </section>
  );
}

/* ── Install ─────────────────────────────────────────────────────────────── */

function Install() {
  return (
    <section className="sec" id="install">
      <h2>Install</h2>
      <p className="kicker">
        The app is distributed as an APK from GitHub Releases. It is not on the
        Play Store, so Android will ask you once for permission to install it.
      </p>

      <h3>1. Download</h3>
      <p>
        Open <a href={RELEASES}>the latest release</a> on the phone itself and
        download <code>Music_Player.apk</code>. Downloading on a computer and
        transferring the file works just as well.
      </p>

      <h3>2. Allow the install</h3>
      <p>
        Tap the downloaded file. The first time, Android will say your browser
        or file manager is not allowed to install apps — follow the prompt to{' '}
        <strong>Settings → Install unknown apps</strong>, turn it on for that
        one app, and come back. You only ever do this once.
      </p>

      <h3>3. First launch</h3>
      <p>
        The first start takes a few seconds longer than later ones: the embedded
        engine unpacks itself and the app restores whatever was playing last.
        The splash screen stays up until both the engine and the home screen are
        genuinely ready, so nothing assembles itself in front of you.
      </p>

      <div className="note tip">
        <b>Updating later is easier.</b> Once installed, the app checks for new
        releases by itself and can download and install them from inside{' '}
        <a href="#updates">Settings</a>. You will not need to repeat any of the
        above.
      </div>

      <h3>Permissions</h3>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Permission</th>
              <th>What it is for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Notifications</td>
              <td>
                The playback notification and its controls. Denying it leaves
                playback working but takes away the lock-screen controls.
              </td>
            </tr>
            <tr>
              <td>Storage</td>
              <td>
                Writing downloaded songs to the folder you choose, and reading
                them back. Asked for only when you first download something.
              </td>
            </tr>
            <tr>
              <td>Install packages</td>
              <td>
                In-app updates. Asked for by the system installer at the moment
                an update is ready, never before.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ── The player ──────────────────────────────────────────────────────────── */

function Player() {
  return (
    <section className="sec" id="player">
      <h2>The player</h2>
      <p className="kicker">
        Tap the mini player above the bottom bar to open it, drag it down to put
        it away. Everything about the song that is playing lives here.
      </p>

      <h3>Reading the screen</h3>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Where</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Top strip</td>
              <td>
                The album you are inside of, or “Now playing”. The chevron on
                the left minimises; so does dragging anywhere on this strip.
              </td>
            </tr>
            <tr>
              <td>Artwork</td>
              <td>
                Swipe it sideways to change song, double-tap either edge to seek.
                Switch it for lyrics with the capsule below.
              </td>
            </tr>
            <tr>
              <td>Title and artist</td>
              <td>
                Tapping the artist opens their page. Where several are credited,
                it asks which one first.
              </td>
            </tr>
            <tr>
              <td>Badges</td>
              <td>
                Which source this is streaming from and at what bitrate. Both
                can be switched off under Settings → Appearance.
              </td>
            </tr>
            <tr>
              <td>⊕ ♥ ⭳</td>
              <td>
                Add to a playlist, like, download. The download glyph turns into
                a green tick once the song is on the phone.
              </td>
            </tr>
            <tr>
              <td>Output</td>
              <td>
                Under the buttons, in green, when something other than the phone
                speaker is connected — the answer to “why is nothing coming out
                of my phone”.
              </td>
            </tr>
            <tr>
              <td>Capsule</td>
              <td>
                Song or lyrics, in the middle of the timestamp row. It goes dim
                when the track genuinely has no lyrics.
              </td>
            </tr>
            <tr>
              <td>Grip</td>
              <td>
                “Your queue”, at the bottom. Pull it up or tap it.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Transport</h3>
      <ul>
        <li>
          <strong>Shuffle</strong> is a real toggle, not a re-roll. Turning it on
          shuffles everything still to come; turning it off puts the original
          order back rather than shuffling again.
        </li>
        <li>
          <strong>Previous</strong> restarts the current song first. It only
          jumps to the song before when you are already within the first three
          seconds — so one stray tap cannot lose your place.
        </li>
        <li>
          <strong>Repeat</strong> is two-state: off, or repeat this song. It
          loops the current track when it ends, while the next button still
          moves on manually.
        </li>
      </ul>

      <SeekDemo />

      <div className="note">
        <b>The bar is 44 pixels of touch for 4 pixels of line.</b> A thin track
        is easy to look at and impossible to hit, so the target is far taller
        than the thing it draws — and a clearly vertical drag that starts on it
        still falls through to minimising the player.
      </div>
    </section>
  );
}

/* ── Gestures ────────────────────────────────────────────────────────────── */

function Gestures() {
  const ref = useRef(null);
  useAnimationGate(ref);

  return (
    <section className="sec" id="gestures">
      <h2>Gestures</h2>
      <p className="kicker">
        The app is built to be driven one-handed. Nothing below is the only way
        to do the thing — there is always a button — but these are the fast
        ways, and they are what the app was designed around.
      </p>

      <div className="gestures" ref={ref}>
        <GestureCard title="Swipe the artwork" stage={stages.swipeArt}>
          Left for the next song, right for the previous one. The incoming
          title travels with the cover, so you can see where you are heading
          before you let go — and you can change your mind mid-drag.
        </GestureCard>

        <GestureCard title="Double-tap to seek" stage={stages.doubleTap}>
          Two taps on the right half of the artwork jump forward ten seconds;
          the left half goes back. Consecutive taps stack, so a quick
          triple-tap goes twenty, a fourth thirty.
        </GestureCard>

        <GestureCard title="Drag down to minimise" stage={stages.dragDown}>
          From the top strip or from the artwork. Let go past about a third of
          the way and it finishes the slide by itself, carrying whatever speed
          you gave it; let go early and it springs back.
        </GestureCard>

        <GestureCard title="Pull up the queue" stage={stages.pullQueue}>
          From the grip at the bottom of the player. It opens as the drag is
          recognised rather than when you let go, so the sheet is already on its
          way up under your finger. Push back down to change your mind.
        </GestureCard>

        <GestureCard title="Swipe in from the edge" stage={stages.edgeDrawer}>
          On Home, drag in from the left edge for the drawer — sleep timer,
          equalizer, your listening, help and settings. The panel tracks your
          finger from the first pixel; release decides whether it opens or
          returns.
        </GestureCard>

        <GestureCard title="Hold a grip to reorder" stage={stages.reorder}>
          In the queue, press and hold the ≡ handle on any upcoming song and
          drag it where you want it. The playing track stays pinned at the top
          and cannot be moved — moving it would stop the music.
        </GestureCard>
      </div>

      <h3>Everywhere else</h3>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Gesture</th>
              <th>Where</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Swipe sideways</td>
              <td>Mini player</td>
              <td>Next or previous song — the same motion as the artwork</td>
            </tr>
            <tr>
              <td>Tap</td>
              <td>Mini player</td>
              <td>Opens the full player</td>
            </tr>
            <tr>
              <td>Long-press</td>
              <td>Any song row</td>
              <td>Opens its actions — queue, playlist, artist, album, download</td>
            </tr>
            <tr>
              <td>Drag down</td>
              <td>Any sheet</td>
              <td>Dismisses it. So does tapping the dimmed area behind it</td>
            </tr>
            <tr>
              <td>Drag</td>
              <td>Equalizer band</td>
              <td>Sets that frequency, snapping to whole decibels</td>
            </tr>
            <tr>
              <td>Drag or tap</td>
              <td>Crossfade bar</td>
              <td>Sets the overlap, snapping to whole seconds</td>
            </tr>
            <tr>
              <td>Back</td>
              <td>Anywhere</td>
              <td>
                Closes what is actually on top, one layer at a time. On Home
                with nothing open, twice within two seconds exits
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="note">
        <b>About that left edge.</b> Android reserves roughly the outer 20–24
        density pixels of each side for its own back gesture and takes those
        touches before any app sees them. The app formally asks the system for
        its 28-pixel strip back, which is why the drawer swipe works at all —
        and why it is a narrow strip rather than the whole screen.
      </div>
    </section>
  );
}

/* ── Queue ───────────────────────────────────────────────────────────────── */

function Queue() {
  return (
    <section className="sec" id="queue">
      <h2>The queue</h2>
      <p className="kicker">
        Pull the grip at the bottom of the player. What you see is the playback
        engine's real queue, not a copy kept alongside it, so it cannot drift
        from what will actually play.
      </p>

      <ul>
        <li>
          <strong>Now playing is pinned</strong> above the list and stays there
          however far you scroll.
        </li>
        <li>
          <strong>Only upcoming songs reorder.</strong> Removing the track that
          is currently playing would stop playback, so the playing row has no
          grip and nothing can be dropped above it.
        </li>
        <li>
          <strong>Tap any row to jump</strong> straight to it.
        </li>
        <li>
          <strong>The heading tells you where the order came from</strong> — “Next
          up” normally, “Shuffling from” when shuffle is on.
        </li>
        <li>
          <strong>Songs marked Recommended</strong> were added by autoplay rather
          than by you.
        </li>
      </ul>

      <h3>Autoplay</h3>
      <p>
        With Autoplay on, the queue tops itself up from a radio built around what
        you have been listening to, so the music does not simply stop when a
        playlist runs out. The top-up rides the playback engine's own track-change
        event rather than a timer, which matters more than it sounds: Android
        freezes an app's timers once the screen is off, and a timer-driven version
        would leave the last song of a queue ending in silence until you next
        picked the phone up.
      </p>

      <div className="note tip">
        <b>Adding to the queue.</b> Long-press any song and choose “Play next” or
        “Add to queue”. Several “play next” choices in a row keep their order
        rather than each one jumping ahead of the last.
      </div>
    </section>
  );
}

/* ── Search & sources ────────────────────────────────────────────────────── */

function Search() {
  return (
    <section className="sec" id="search">
      <h2>Search &amp; sources</h2>
      <p className="kicker">
        One search box, three catalogues. Results are merged and ranked
        together, with near-duplicates from different sources collapsed into one
        row.
      </p>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Best for</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>JioSaavn</td>
              <td>Studio releases, Indian catalogue</td>
              <td>
                Full-catalogue streaming up to 320 kbps, with proper album
                artwork and metadata
              </td>
            </tr>
            <tr>
              <td>SoundCloud</td>
              <td>Remixes, uploads, independent artists</td>
              <td>
                Some uploads are preview-only or region-locked and will be
                skipped automatically
              </td>
            </tr>
            <tr>
              <td>YouTube</td>
              <td>Anything the other two do not have</td>
              <td>
                The fallback of last resort — slower to resolve, and the most
                likely to carry a live or cover version
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>What the ranking does for you</h3>
      <ul>
        <li>
          The studio cut outranks the “slowed + reverb” bootleg — unless you
          actually searched for one, in which case it does not.
        </li>
        <li>
          Live, cover, karaoke, instrumental, nightcore and remix uploads are
          demoted when your query did not ask for them.
        </li>
        <li>
          A track that fails to play is skipped, with a note saying which one and
          why, rather than leaving the player stuck on it.
        </li>
      </ul>

      <h3>Importing from Spotify</h3>
      <p>
        Paste a public Spotify playlist or album link into the search box. The
        app reads the track list, finds each song across its own sources, and
        saves the result as an ordinary playlist you can edit like any other.
        Nothing is signed into and nothing is sent to Spotify beyond fetching the
        public page.
      </p>
    </section>
  );
}

/* ── Library & downloads ─────────────────────────────────────────────────── */

function Library() {
  return (
    <section className="sec" id="library">
      <h2>Library &amp; downloads</h2>
      <p className="kicker">
        Your Library holds everything you have kept: liked songs, playlists,
        albums, followed artists and downloads. Filter it by kind along the top,
        and pin the ones you open most to keep them first.
      </p>

      <h3>Downloads</h3>
      <ul>
        <li>
          Downloading writes a real audio file with the artwork and tags
          embedded, into a folder you pick under{' '}
          <strong>Settings → Downloads</strong>.
        </li>
        <li>
          Downloaded songs play with no connection at all, and they carry an{' '}
          <strong>Offline</strong> badge so you can tell at a glance.
        </li>
        <li>
          The tick beside a song means it is on the phone. It appears the moment
          a download finishes, without needing the screen reopened.
        </li>
        <li>
          Deleting a download removes the file. Deleting the app leaves the
          folder exactly where it is.
        </li>
        <li>
          <strong>Open in Files</strong> under Settings takes you to the folder
          in your file manager.
        </li>
      </ul>

      <div className="note">
        <b>Streaming does not save anything.</b> Playing a song through does not
        leave a copy behind — that is deliberate, not an oversight. An invisible
        cache that grows without limit and empties itself when you are not
        looking is worse than no cache at all. Download is the feature that keeps
        a song.
      </div>

      <h3>Your sound</h3>
      <p>
        In the drawer. A week of listening, summarised: how long, which days,
        which artists. It is computed from the play log on the device and is
        never uploaded anywhere.
      </p>
    </section>
  );
}

/* ── Sound ───────────────────────────────────────────────────────────────── */

function Sound() {
  return (
    <section className="sec" id="sound">
      <h2>Sound</h2>
      <p className="kicker">
        Four controls, all under the drawer or Settings → Playback. Each one acts
        on the audio that is already running — there is no “apply” step.
      </p>

      <h3>Equalizer</h3>
      <p>
        Eight bands from 60&nbsp;Hz to 16&nbsp;kHz, −12 to +12&nbsp;dB, with
        eleven presets and a Custom curve. Drag any band and you land in Custom,
        seeded from whatever was on screen — so a preset is a starting point
        rather than a cage.
      </p>
      <p>
        Android does not let an app choose its own band frequencies. Most phones
        expose five bands at frequencies of their own choosing; some expose ten,
        with a different gain range again. The eight-band curve you draw is{' '}
        <strong>interpolated onto whatever your device actually has</strong>, in
        log frequency rather than linear, and clamped to its real range. Nothing
        here is tuned for one handset.
      </p>

      <EqDemo />

      <div className="note warn">
        <b>“Play something first.”</b> Audio effects attach to a live audio
        session, so the equalizer has nothing to attach to until something is
        playing. If it says a device refused the effects instead, that is your
        phone declining them on an offloaded audio path — some handsets do, and
        the app will say so plainly rather than sitting there doing nothing.
      </div>

      <h3>Crossfade</h3>
      <p>
        Overlaps the end of one song into the start of the next, from nought to
        twelve seconds. Nought is off, which is the right answer for albums that
        were sequenced to run together.
      </p>

      <CrossfadeDemo />

      <h3>Normalize volume</h3>
      <p>
        Evens out loudness between tracks so a quiet 1970s master and a
        loudness-war remaster sit at roughly the same level. It is a gain applied
        to the live session, so it takes effect immediately and costs nothing
        when switched off.
      </p>

      <h3>Sleep timer</h3>
      <p>
        In the drawer: fifteen, thirty, forty-five or sixty minutes, or the end
        of the current track. The remaining time is shown on the drawer row while
        it runs, and it fires from the playback engine's own events rather than a
        JavaScript timer — so it still works with the screen off, which is the
        only time anybody uses it.
      </p>
    </section>
  );
}

/* ── Settings ────────────────────────────────────────────────────────────── */

function Settings() {
  return (
    <section className="sec" id="settings">
      <h2>Settings</h2>
      <p className="kicker">
        Reached from the drawer. Anything with more than a switch's worth of
        choice opens as its own screen rather than expanding in place, so the
        list stays scannable.
      </p>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Setting</th>
              <th>Default</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Autoplay</td>
              <td>On</td>
              <td>Keeps playing similar songs when the queue runs out</td>
            </tr>
            <tr>
              <td>Normalize volume</td>
              <td>Off</td>
              <td>Plays every track at roughly the same loudness</td>
            </tr>
            <tr>
              <td>Crossfade</td>
              <td>Off</td>
              <td>Overlap between songs, 0–12 seconds</td>
            </tr>
            <tr>
              <td>Equalizer</td>
              <td>Off</td>
              <td>Eight-band shaping, eleven presets plus Custom</td>
            </tr>
            <tr>
              <td>Streaming quality</td>
              <td>Auto</td>
              <td>
                Auto, 96, 128, 256 or 320 kbps. A ceiling, not a promise — a
                source that has no 320 stream still gives you its best
              </td>
            </tr>
            <tr>
              <td>Sleep timer</td>
              <td>Off</td>
              <td>15/30/45/60 minutes, or the end of the current track</td>
            </tr>
            <tr>
              <td>Download folder</td>
              <td>Music</td>
              <td>Where downloaded files are written</td>
            </tr>
            <tr>
              <td>Show source label</td>
              <td>On</td>
              <td>The JioSaavn / SoundCloud / YouTube badge on rows</td>
            </tr>
            <tr>
              <td>Show quality label</td>
              <td>On</td>
              <td>The kbps badge on rows</td>
            </tr>
            <tr>
              <td>Automatic updates</td>
              <td>On</td>
              <td>Checks for a new release quietly in the background</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Clear cache</h3>
      <p>
        Frees temporary files, saved lyrics and your search history. Downloads,
        playlists and liked songs are not touched.
      </p>

      <h3>Reset all settings</h3>
      <p>
        Puts every switch back to its default. Your library — likes, playlists,
        downloads — is not touched.
      </p>
    </section>
  );
}

/* ── Updates ─────────────────────────────────────────────────────────────── */

function Updates() {
  return (
    <section className="sec" id="updates">
      <h2>Updates</h2>
      <p className="kicker">
        The app checks GitHub for a newer release by itself, downloads it on
        request, and hands it to Android's own installer. You confirm the
        install; nothing happens behind your back.
      </p>

      <ul>
        <li>
          <strong>A green dot on Settings in the drawer</strong> means a newer
          version is out. Opening Settings from the drawer takes you straight to
          it.
        </li>
        <li>
          <strong>Checks run at launch and whenever you return to the app</strong>
          , debounced to at most one every fifteen minutes. The second half
          matters: a phone kept awake by the playback service can go days without
          a cold start, and a launch-only check would never reach it.
        </li>
        <li>
          <strong>Dismissing the notice hides the popup, not the update.</strong>{' '}
          The dot stays lit and Settings keeps offering it until you install or
          a newer release replaces it.
        </li>
        <li>
          <strong>A download in progress survives navigation.</strong> Leaving
          the Settings screen does not cancel it.
        </li>
        <li>
          Turn the whole thing off with <strong>Automatic updates</strong>. The
          manual “Check for updates” button always works regardless.
        </li>
      </ul>

      <div className="note">
        <b>Your data is not touched by an update.</b> Installing over the top
        keeps likes, playlists, downloads and settings. Downloads live outside
        the app's own storage in any case.
      </div>
    </section>
  );
}

/* ── Troubleshooting ─────────────────────────────────────────────────────── */

function Faq() {
  const items = [
    [
      'The equalizer says to play something first',
      'Audio effects attach to a live audio session, and there is no session until something is playing. Start a song, then open the equalizer. If it instead reports that the device refused the effects, your phone is declining them on an offloaded audio path — some do, and there is no way around it from inside an app.',
    ],
    [
      'A song skipped by itself',
      'That source had no playable stream for it — a preview-only SoundCloud upload, a region-locked track, or a dead link. The app says which song was skipped rather than failing silently, and the same song is often available from another source: search it again and pick a row with a different badge.',
    ],
    [
      'No lyrics for this song',
      'The lyrics segment goes dim when the track genuinely has none on the lyrics provider, which is common for SoundCloud and YouTube uploads. It is not a failed fetch — the app checked, and there is nothing there.',
    ],
    [
      'A downloaded song is not showing as downloaded',
      'Downloaded files are matched by title and artist, because a file on disk carries no catalogue identifier. If you renamed the file or edited its tags, the match is lost. Re-scanning happens whenever the Library tab is opened.',
    ],
    [
      'Playback carried on after I closed the app',
      'Swiping the app away from Recents stops playback and removes the notification. If it did not, you are on a build before v1.0.11 — updating fixes it.',
    ],
    [
      'The volume jumped when I started a song',
      'Fixed in v1.0.9. Enabling an audio effect on a live session makes Android re-route the audio, which is audible as a step in level; the app no longer creates effects it is not going to use. Opening the equalizer screen mid-song can still cost one, because reading the real band count needs a live effect.',
    ],
    [
      'Search is slow or comes back empty',
      'The engine searches three catalogues with a deadline and returns whatever arrived in time, so a slow source degrades the results rather than hanging the search. An empty result usually means no connection — the app works fully offline for downloads, and not at all for search.',
    ],
    [
      'The drawer will not open by swiping',
      'The strip is the outer 28 pixels of the left edge, on Home only, and Android also uses that area for its own back gesture. If your phone is set to three-button navigation the conflict disappears; either way the hamburger in the Home header always works.',
    ],
  ];

  return (
    <section className="sec" id="faq">
      <h2>Troubleshooting</h2>
      <p className="kicker">
        The questions that actually come up, with the real reason rather than a
        reassurance.
      </p>

      {items.map(([q, a]) => (
        <div key={q}>
          <h3>{q}</h3>
          <p>{a}</p>
        </div>
      ))}

      <div className="note">
        <b>Still stuck?</b> Settings → Diagnostics reports what the audio engine
        can see — whether the playback service is bound, which audio session is
        live, whether the effects attached, and the last error it hit. That page
        answers most “it is not working” questions without a cable.{' '}
        <a href={`${REPO}/issues`}>Open an issue</a> with what it says.
      </div>
    </section>
  );
}

export function Content() {
  return (
    <>
      <Overview />
      <Install />
      <Player />
      <Gestures />
      <Queue />
      <Search />
      <Library />
      <Sound />
      <Settings />
      <Updates />
      <Faq />
    </>
  );
}
