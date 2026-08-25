/**
 * Layout, navigation and the two things that make a long page navigable: a
 * table of contents that knows where you are, and sections that arrive rather
 * than simply being there.
 *
 * The mobile navigation is a left drawer with a scrim, deliberately: it is the
 * same gesture and the same panel the app itself uses, so someone who has the
 * app already knows how this page works.
 */
import {useCallback, useEffect, useState} from 'react';
import {Content, RELEASES, REPO, SECTIONS} from './sections.jsx';
import './styles.css';

const LOGO = `${import.meta.env.BASE_URL}logo.png`;

/** Which section is on screen, for the contents list. */
function useScrollSpy() {
  const [active, setActive] = useState(SECTIONS[0].id);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }
    // A band across the upper third: the heading nearest the top of what you
    // are reading is the one you are reading, which is not the same as the one
    // most visible. Tracking "most visible" makes the marker lag by a section
    // on anything long.
    const io = new IntersectionObserver(
      entries => {
        const onScreen = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (onScreen.length) {
          setActive(onScreen[0].target.id);
        }
      },
      {rootMargin: '-64px 0px -68% 0px', threshold: 0},
    );
    SECTIONS.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) {
        io.observe(el);
      }
    });
    return () => io.disconnect();
  }, []);

  return active;
}

/** Sections fade up as they arrive. Applied from JS, never from the markup, so
 *  a browser without IntersectionObserver shows everything instead of nothing. */
function useReveal() {
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }
    const targets = document.querySelectorAll('.sec');
    targets.forEach(el => el.classList.add('reveal'));

    const io = new IntersectionObserver(
      entries => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      {rootMargin: '0px 0px -40px 0px', threshold: 0.02},
    );
    targets.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function Brand() {
  return (
    <a className="brand" href="#overview">
      <img src={LOGO} alt="" width="28" height="28" />
      <span>
        Fix_Music
        <small>Documentation</small>
      </span>
    </a>
  );
}

function Nav({active, onPick}) {
  return (
    <nav aria-label="Contents">
      <p className="nav-title">Contents</p>
      {SECTIONS.map(s => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className={`nav-link${active === s.id ? ' on' : ''}`}
          aria-current={active === s.id ? 'true' : undefined}
          onClick={onPick}>
          {s.label}
        </a>
      ))}
      <p className="nav-title">Elsewhere</p>
      <a className="nav-link" href={RELEASES} onClick={onPick}>
        Releases
      </a>
      <a className="nav-link" href={REPO} onClick={onPick}>
        Source
      </a>
    </nav>
  );
}

function Hero() {
  return (
    <header className="hero">
      <span className="eyebrow">Android · free · no account</span>
      <h1>
        Everything Fix_Music does,
        <br />
        and how to do it.
      </h1>
      <p className="lede">
        Three catalogues searched as one. Downloads that are real files in a
        folder you chose. An equalizer mapped onto your phone's actual hardware.
        And a gesture for every common action, because you are holding this
        thing in one hand.
      </p>

      <div className="hero-actions">
        <a className="cta" href={RELEASES}>
          ⭳ Download the APK
        </a>
        <a className="ghost" href="#gestures">
          See the gestures
        </a>
      </div>

      <div className="facts">
        <div className="fact">
          <b>3</b>
          <span>sources, one list</span>
        </div>
        <div className="fact">
          <b>8</b>
          <span>equalizer bands</span>
        </div>
        <div className="fact">
          <b>0</b>
          <span>accounts, ever</span>
        </div>
        <div className="fact">
          <b>100%</b>
          <span>on the device</span>
        </div>
      </div>
    </header>
  );
}

export default function App() {
  const active = useScrollSpy();
  const [open, setOpen] = useState(false);
  useReveal();

  const close = useCallback(() => setOpen(false), []);

  // Escape closes the drawer, and the page behind it must not scroll under it.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = e => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <div className="top">
        <button
          type="button"
          className="burger"
          aria-label="Open the contents"
          aria-expanded={open}
          onClick={() => setOpen(v => !v)}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M3 6h18M3 12h18M3 18h18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>

        <Brand />
        <div className="top-spacer" />

        <div className="top-links">
          <a href="#install">Install</a>
          <a href="#gestures">Gestures</a>
          <a href="#sound">Sound</a>
          <a href="#faq">Help</a>
        </div>

        <a className="cta" href={RELEASES}>
          Download
        </a>
      </div>

      <div
        className={`scrim${open ? ' on' : ''}`}
        onClick={close}
        aria-hidden="true"
      />
      {/* inert while closed: the panel is only off-screen by a transform, so
          without this its links stay in the tab order behind the page. */}
      <aside
        className={`drawer${open ? ' on' : ''}`}
        inert={open ? undefined : 'true'}>
        <Brand />
        <Nav active={active} onPick={close} />
      </aside>

      <div className="shell">
        <aside className="side">
          <Nav active={active} />
        </aside>

        <main className="main">
          <Hero />
          <Content />
        </main>
      </div>

      <footer className="foot">
        <div className="foot-links">
          <a href={REPO}>Source</a>
          <a href={RELEASES}>Releases</a>
          <a href={`${REPO}/issues`}>Report a problem</a>
          <a href={`${REPO}/blob/mobile/LICENSE`}>Licence</a>
        </div>
        <p>
          Fix_Music is a personal project, not affiliated with Spotify,
          JioSaavn, SoundCloud or YouTube. Respect the rights of the people who
          made the music you listen to.
        </p>
      </footer>
    </>
  );
}
