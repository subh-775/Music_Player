/**
 * The product mark, the release badges, the seek bar and the gesture loops.
 *
 * A screenshot of a control tells you it exists; a control you can drag tells
 * you how it behaves, so the seek bar here follows the rules the app's own
 * does. Pointer events rather than mouse/touch pairs: one path covers a mouse,
 * a finger and a stylus, and setPointerCapture keeps a drag alive when it
 * wanders off the element instead of dying silently.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {SITE} from './nav.js';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/* ── The product mark ────────────────────────────────────────────────────── */

/**
 * The application's own icon, at the size the home page can give it.
 *
 * The hero used to hold a working equalizer. It was a good control and the
 * wrong thing to open with: a reader arriving at the front page is deciding
 * whether this is the product they want, not adjusting 6 kHz. The icon answers
 * that question in one glance and is the same mark they will look for on the
 * home screen afterwards.
 */
export function AppMark() {
  return (
    <div className="appmark" aria-hidden="true">
      <span className="appmark-halo" />
      <img src={`${BASE}/logo.png`} alt="" width="220" height="220" />
    </div>
  );
}

/* ── Release badges ──────────────────────────────────────────────────────── */

/**
 * Version, downloads and stars, read from GitHub when the page is viewed.
 *
 * Read rather than written down, so the latest version is whatever is actually
 * published — there is no number in this repository that can fall behind the
 * releases. Each is a label and a value, the shape a repository badge has had
 * for a decade, which means it needs no explaining.
 */
export function ReleaseBadges() {
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(`${SITE.api}/releases/latest`).then(r => (r.ok ? r.json() : null)),
      fetch(SITE.api).then(r => (r.ok ? r.json() : null)),
    ])
      .then(([release, repo]) => {
        if (!alive) {
          return;
        }
        setData({
          tag: release?.tag_name ?? null,
          // null, not 0, when the request did not come back. A rate-limited
          // read that reports "0 downloads" is not a graceful fallback, it is
          // a wrong number stated confidently.
          downloads: release
            ? (release.assets || []).reduce(
                (n, a) => n + (a.download_count || 0),
                0,
              )
            : null,
          stars: repo?.stargazers_count ?? null,
        });
      })
      // An unauthenticated GitHub request is rate limited per address, so a
      // miss here is ordinary. The badges simply show a dash.
      .catch(() => alive && setData({tag: null, downloads: null, stars: null}));
    return () => {
      alive = false;
    };
  }, []);

  const cells = [
    ['Release', data?.tag ?? '—'],
    ['Downloads', data && data.downloads != null ? String(data.downloads) : '—'],
    ['Stars', data && data.stars != null ? String(data.stars) : '—'],
  ];

  return (
    <div className={`badges${data ? '' : ' badges-wait'}`}>
      {cells.map(([label, value]) => (
        <span className="badge" key={label}>
          <span className="badge-label">{label}</span>
          <span className="badge-value">{value}</span>
        </span>
      ))}
    </div>
  );
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function HBar({value, max, steps, onChange, label}) {
  const track = useRef(null);
  const [held, setHeld] = useState(false);

  const apply = useCallback(
    e => {
      const box = track.current?.getBoundingClientRect();
      if (!box) {
        return;
      }
      const raw = clamp((e.clientX - box.left) / box.width, 0, 1) * max;
      onChange(steps ? Math.round(raw) : raw);
    },
    [max, steps, onChange],
  );

  const pct = (value / max) * 100;

  return (
    <div
      ref={track}
      className="hbar"
      role="slider"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={e => {
        const step = steps ? 1 : max / 40;
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          onChange(Math.min(max, value + step));
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onChange(Math.max(0, value - step));
        }
      }}
      onPointerDown={e => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setHeld(true);
        apply(e);
      }}
      onPointerMove={e => e.buttons && apply(e)}
      onPointerUp={() => setHeld(false)}
      onPointerCancel={() => setHeld(false)}>
      <div className="hbar-track">
        <div className="hbar-fill" style={{width: `${pct}%`}} />
      </div>
      <div
        className={`hbar-knob${held ? ' big' : ''}`}
        style={{left: `${pct}%`}}
      />
    </div>
  );
}

const clock = secs => {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function SeekDemo() {
  const DURATION = 218; // 3:38, a normal-length song
  const [pos, setPos] = useState(74);

  return (
    <div className="demo">
      <div className="demo-head">
        <h4>Seek bar</h4>
        <span>drag or tap</span>
      </div>
      <p className="demo-sub">
        Scrubbing is continuous; the seek happens once, on release — one range
        request rather than one per pixel.
      </p>
      <HBar value={pos} max={DURATION} steps={0} onChange={setPos} label="Position" />
      <div className="hbar-ends">
        <span>{clock(pos)}</span>
        <span>{clock(DURATION)}</span>
      </div>
    </div>
  );
}

/* ── Gesture cards ───────────────────────────────────────────────────────── */

function Phone({children, className = ''}) {
  return <div className={`phone ${className}`}>{children}</div>;
}

const art = (
  <>
    <div className="pill-art" />
    <div className="pill-line a" />
    <div className="pill-line b" />
  </>
);

const STAGES = {
  swipe: (
    <>
      <Phone>
        <div className="anim-art">{art}</div>
      </Phone>
      <div className="finger f-left" style={{left: 'calc(50% - 10px)', top: 60}} />
    </>
  ),
  doubleTap: (
    <>
      <Phone>
        {art}
        <div className="seekflash f-flash">+10s</div>
      </Phone>
      <div className="finger f-tap" style={{left: 'calc(50% + 16px)', top: 56}} />
    </>
  ),
  dragDown: (
    <>
      <Phone className="anim-drop">{art}</Phone>
      <div className="finger f-down" style={{left: 'calc(50% - 10px)', top: 26}} />
    </>
  ),
  pullUp: (
    <>
      <Phone>
        {art}
        <div className="sheet-up anim-pull" />
      </Phone>
      <div className="finger f-up" style={{left: 'calc(50% - 10px)', top: 106}} />
    </>
  ),
  edge: (
    <>
      <Phone>
        {art}
        <div className="drawer-in anim-drawer" />
      </Phone>
      <div className="finger f-right" style={{left: 'calc(50% - 34px)', top: 66}} />
    </>
  ),
  reorder: (
    <>
      <Phone>
        <div className="qrow r1" />
        <div className="qrow r2" />
        <div className="qrow r3 anim-lift" />
      </Phone>
      <div className="finger f-up" style={{left: 'calc(50% + 26px)', top: 108}} />
    </>
  ),
};

const CARDS = [
  [
    'swipe',
    'Swipe the artwork',
    'Left for the next song, right for the previous one. The incoming title travels with the cover, so you can see where you are heading before you let go — and you can change your mind mid-drag.',
  ],
  [
    'doubleTap',
    'Double-tap to seek',
    'Two taps on the right half of the artwork jump forward ten seconds; the left half goes back. Consecutive taps stack, so a quick triple-tap goes twenty and a fourth thirty.',
  ],
  [
    'dragDown',
    'Drag down to minimise',
    'From the top strip or from the artwork. Let go past about a third of the way and it finishes the slide by itself, carrying the speed you gave it; let go early and it springs back.',
  ],
  [
    'pullUp',
    'Pull up the queue',
    'From anywhere along the bottom row of the player, or by tapping the queue glyph on its right. The sheet opens as the drag is recognised rather than when you let go, so it is already on its way up under your finger. Push back down to change your mind.',
  ],
  [
    'edge',
    'Swipe in from the edge',
    'On Home, drag in from the left edge for the drawer. The panel tracks your finger from the first pixel; the release decides whether it opens or returns.',
  ],
  [
    'reorder',
    'Hold a handle to reorder',
    'In the queue, press and hold the handle on any upcoming song and drag it where you want it. The playing track stays pinned and cannot be moved — moving it would stop the music.',
  ],
];

/**
 * Every loop pauses while the grid is off screen. Six infinite CSS animations
 * running behind content nobody is looking at is a battery cost with no
 * benefit, and on a phone that is a real one.
 */
export function GestureGrid() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        const state = entry.isIntersecting ? 'running' : 'paused';
        el.querySelectorAll('*').forEach(n => {
          n.style.animationPlayState = state;
        });
      },
      {rootMargin: '140px'},
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="gestures" ref={ref}>
      {CARDS.map(([stage, title, body]) => (
        <div className="gcard" key={stage}>
          <div className="gstage" aria-hidden="true">
            {STAGES[stage]}
          </div>
          <div className="gtext">
            <h4>{title}</h4>
            <p>{body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
