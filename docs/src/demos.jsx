/**
 * Live reproductions of the app's own controls.
 *
 * A screenshot of a slider tells you it exists; a slider you can drag tells you
 * how it behaves. These are the three controls people actually ask about, built
 * with the same rules the app uses — whole-number snapping, a knob that grows
 * under the finger, and a value that is only ever what is on screen.
 *
 * Pointer events rather than mouse/touch pairs: one code path covers a mouse, a
 * finger and a stylus, and setPointerCapture means a drag that wanders off the
 * element keeps tracking instead of dying silently.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

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

function hzLabel(hz) {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
        Eight bands, −12 to +12&nbsp;dB, snapping to whole decibels. Moving any
        one of them puts you in Custom.
      </p>

      <div className="bands">
        {BANDS.map((hz, i) => (
          <Band
            key={hz}
            hz={hz}
            value={gains[i]}
            onChange={db => setBand(i, db)}
          />
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

  // 0 at the bottom of the column, 1 at the top.
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
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId);
          apply(e);
        }}
        onPointerMove={e => {
          // buttons is a bitmask of what is held down — 0 means this is a hover,
          // not a drag, and a hover must not move the band.
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

/**
 * The shared body of the seek bar and the crossfade slider.
 *
 * `steps` of 0 means continuous (the seek bar); any other number snaps to that
 * many divisions on release, which is how the crossfade lands on a whole second
 * rather than on 8.62.
 */
function HBar({value, max, steps, green, onChange, onCommit}) {
  const track = useRef(null);
  const [held, setHeld] = useState(false);

  const apply = useCallback(
    (e, commit) => {
      const box = track.current?.getBoundingClientRect();
      if (!box) {
        return;
      }
      const frac = clamp((e.clientX - box.left) / box.width, 0, 1);
      const raw = frac * max;
      const v = steps ? Math.round(raw) : raw;
      onChange(v);
      if (commit) {
        onCommit?.(v);
      }
    },
    [max, steps, onChange, onCommit],
  );

  const pct = (value / max) * 100;

  return (
    <div
      ref={track}
      className="hbar"
      onPointerDown={e => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setHeld(true);
        apply(e, false);
      }}
      onPointerMove={e => {
        if (e.buttons) {
          apply(e, false);
        }
      }}
      onPointerUp={e => {
        setHeld(false);
        apply(e, true);
      }}
      onPointerCancel={() => setHeld(false)}>
      <div className="hbar-track">
        <div
          className={`hbar-fill${green ? ' green' : ''}`}
          style={{width: `${pct}%`}}
        />
      </div>
      <div
        className={`hbar-knob${green ? ' green' : ''}${held ? ' big' : ''}`}
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
        Scrubbing is continuous; the seek itself happens once, on release — one
        range request rather than one per pixel.
      </p>

      <HBar value={pos} max={DURATION} steps={0} onChange={setPos} />

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
        <span>drag or tap</span>
      </div>
      <p className="demo-sub">
        Nought to twelve seconds, snapping to whole ones. Nought reads as Off.
      </p>

      <div className="demo-head" style={{marginBottom: 2}}>
        <span style={{textTransform: 'none', letterSpacing: 0, fontSize: 13}}>
          Overlap the end of one song into the next
        </span>
        <span className={`hbar-value${secs === 0 ? ' off' : ''}`}>
          {secs > 0 ? `${secs}s` : 'Off'}
        </span>
      </div>

      <HBar
        value={secs}
        max={12}
        steps={12}
        green
        onChange={v => setSecs(Math.round(v))}
      />

      <div className="hbar-ends">
        <span>Off</span>
        <span>12s</span>
      </div>
    </div>
  );
}

/* ── Gesture cards ───────────────────────────────────────────────────────── */

export function GestureCard({title, children, stage}) {
  return (
    <div className="gcard">
      <div className="gstage" aria-hidden="true">
        {stage}
      </div>
      <div className="gtext">
        <h4>{title}</h4>
        <p>{children}</p>
      </div>
    </div>
  );
}

/** The phone body every stage is drawn inside. */
function Phone({children, className = ''}) {
  return <div className={`phone ${className}`}>{children}</div>;
}

const artAndLines = (
  <>
    <div className="pill-art" />
    <div className="pill-line a" />
    <div className="pill-line b" />
  </>
);

export const stages = {
  swipeArt: (
    <>
      <Phone>
        <div className="anim-art">{artAndLines}</div>
      </Phone>
      <div
        className="finger f-left"
        style={{left: 'calc(50% - 10px)', top: '58px'}}
      />
    </>
  ),

  doubleTap: (
    <>
      <Phone>
        {artAndLines}
        <div className="seekflash f-flash">+10s</div>
      </Phone>
      <div
        className="finger f-tap"
        style={{left: 'calc(50% + 16px)', top: '54px'}}
      />
    </>
  ),

  dragDown: (
    <>
      <Phone className="anim-drop">{artAndLines}</Phone>
      <div
        className="finger f-down"
        style={{left: 'calc(50% - 10px)', top: '24px'}}
      />
    </>
  ),

  pullQueue: (
    <>
      <Phone>
        {artAndLines}
        <div className="sheet-up anim-pull" />
      </Phone>
      <div
        className="finger f-up"
        style={{left: 'calc(50% - 10px)', top: '104px'}}
      />
    </>
  ),

  edgeDrawer: (
    <>
      <Phone>
        {artAndLines}
        <div className="drawer-in anim-drawer" />
      </Phone>
      <div
        className="finger f-right"
        style={{left: 'calc(50% - 34px)', top: '64px'}}
      />
    </>
  ),

  reorder: (
    <>
      <Phone>
        <div className="qrow r1" />
        <div className="qrow r2" />
        <div className="qrow r3 anim-lift" />
      </Phone>
      <div
        className="finger f-up"
        style={{left: 'calc(50% + 26px)', top: '106px'}}
      />
    </>
  ),
};

/** Pauses every looping animation while the section is off screen. A grid of
 *  six infinite CSS loops running behind content nobody is looking at is a
 *  battery cost with no benefit. */
export function useAnimationGate(ref) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        el.style.setProperty(
          'animation-play-state',
          entry.isIntersecting ? 'running' : 'paused',
        );
        el.querySelectorAll('*').forEach(node => {
          node.style.animationPlayState = entry.isIntersecting
            ? 'running'
            : 'paused';
        });
      },
      {rootMargin: '120px'},
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
}
