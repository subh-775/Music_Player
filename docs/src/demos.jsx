/**
 * Live reproductions of the app's own controls, and the gesture loops.
 *
 * A screenshot of a slider tells you it exists; a slider you can drag tells you
 * how it behaves. These follow the same rules the app does — whole-number
 * snapping, a knob that grows under the finger, a value that is only ever what
 * is on screen — so the page is a rehearsal rather than a description.
 *
 * Pointer events rather than mouse/touch pairs: one path covers a mouse, a
 * finger and a stylus, and setPointerCapture keeps a drag alive when it wanders
 * off the element instead of dying silently.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ── Equalizer ───────────────────────────────────────────────────────────── */

// The app's real values — src/eq.ts. Documenting different ones would be worse
// than documenting none.
const BANDS = [60, 150, 400, 1000, 2400, 6000, 12000, 16000];
const MIN_DB = -12;
const MAX_DB = 12;

const PRESETS = [
  {id: 'flat', label: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0]},
  {id: 'rock', label: 'Rock', gains: [5, 3, -1, -2, 1, 3, 4, 4]},
  {id: 'metal', label: 'Metal', gains: [6, 4, -2, -3, 2, 5, 5, 3]},
  {id: 'pop', label: 'Pop', gains: [-1, 2, 4, 4, 2, -1, -1, -2]},
  {id: 'hiphop', label: 'Hip-Hop', gains: [7, 5, 1, -1, -1, 1, 2, 3]},
  {id: 'bass', label: 'Bass Boost', gains: [9, 7, 4, 1, 0, 0, 0, 0]},
  {id: 'vocal', label: 'Vocal', gains: [-3, -2, 2, 5, 5, 3, 0, -2]},
];

const hzLabel = hz => (hz >= 1000 ? `${hz / 1000}k` : String(hz));

export function EqDemo() {
  const [gains, setGains] = useState(PRESETS[1].gains);
  const [preset, setPreset] = useState('rock');

  const setBand = useCallback((i, db) => {
    setGains(prev => {
      const next = prev.slice();
      next[i] = db;
      return next;
    });
    setPreset('custom');
  }, []);

  return (
    <div className="demo">
      <div className="demo-head">
        <h4>Equalizer</h4>
        <span>drag a band</span>
      </div>
      <p className="demo-sub">
        Eight bands, −12 to +12 dB, snapping to whole decibels. Moving any one of
        them puts you in Custom.
      </p>

      <div className="bands">
        {BANDS.map((hz, i) => (
          <Band key={hz} hz={hz} value={gains[i]} onChange={db => setBand(i, db)} />
        ))}
      </div>

      <div className="presets">
        {PRESETS.map(p => (
          <button
            key={p.id}
            type="button"
            className={`preset${preset === p.id ? ' on' : ''}`}
            onClick={() => {
              setPreset(p.id);
              setGains(p.gains);
            }}>
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className={`preset${preset === 'custom' ? ' on' : ''}`}
          onClick={() => setPreset('custom')}>
          Custom
        </button>
      </div>
    </div>
  );
}

function Band({hz, value, onChange}) {
  const col = useRef(null);
  const t = (value - MIN_DB) / (MAX_DB - MIN_DB);

  const apply = useCallback(
    e => {
      const box = col.current?.getBoundingClientRect();
      if (!box) {
        return;
      }
      const frac = clamp(1 - (e.clientY - box.top) / box.height, 0, 1);
      onChange(Math.round(MIN_DB + frac * (MAX_DB - MIN_DB)));
    },
    [onChange],
  );

  return (
    <div className="band">
      <div className="band-db">
        {value > 0 ? '+' : ''}
        {value}
      </div>
      <div
        ref={col}
        className="band-col"
        role="slider"
        aria-label={`${hzLabel(hz)} hertz`}
        aria-valuenow={value}
        aria-valuemin={MIN_DB}
        aria-valuemax={MAX_DB}
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            onChange(Math.min(MAX_DB, value + 1));
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            onChange(Math.max(MIN_DB, value - 1));
          }
        }}
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId);
          apply(e);
        }}
        onPointerMove={e => {
          // `buttons` is a bitmask of what is held. Zero means this is a hover,
          // and a hover must not move the band.
          if (e.buttons) {
            apply(e);
          }
        }}>
        <div className="band-track" />
        <div className="band-fill" style={{height: `${t * 100}%`}} />
        <div className="band-knob" style={{bottom: `${t * 100}%`}} />
      </div>
      <div className="band-hz">{hzLabel(hz)}</div>
    </div>
  );
}

/* ── Horizontal bars ─────────────────────────────────────────────────────── */

/** `steps` of 0 means continuous (the seek bar); anything else snaps, which is
 *  how the crossfade lands on a whole second rather than on 8.62. */
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

export function CrossfadeDemo() {
  const [secs, setSecs] = useState(9);

  return (
    <div className="demo">
      <div className="demo-head">
        <h4>Crossfade</h4>
        <span className={`hbar-value${secs === 0 ? ' off' : ''}`}>
          {secs > 0 ? `${secs}s` : 'Off'}
        </span>
      </div>
      <p className="demo-sub">
        Overlap the end of one song into the next. Nought to twelve seconds,
        snapping to whole ones.
      </p>
      <HBar
        value={secs}
        max={12}
        steps={12}
        onChange={v => setSecs(Math.round(v))}
        label="Crossfade seconds"
      />
      <div className="hbar-ends">
        <span>Off</span>
        <span>12s</span>
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
    'From the grip at the bottom of the player. It opens as the drag is recognised rather than when you let go, so the sheet is already on its way up under your finger. Push back down to change your mind.',
  ],
  [
    'edge',
    'Swipe in from the edge',
    'On Home, drag in from the left edge for the drawer. The panel tracks your finger from the first pixel; the release decides whether it opens or returns.',
  ],
  [
    'reorder',
    'Hold a grip to reorder',
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
