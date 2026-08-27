/**
 * The shell: routing, header, sidebar, on-this-page, and the page footer.
 *
 * ## Routing
 *
 * A ~40-line path router rather than a library. The site is a fixed list of
 * routes known at build time (src/nav.js), the build emits a real HTML file for
 * each of them, and there is nothing dynamic to match — a router that can parse
 * `/users/:id/posts/*` is solving a problem this site does not have.
 *
 * Pages are imported EAGERLY. Twenty compiled MDX modules are a few tens of
 * kilobytes gzipped, and paying that once at load buys navigation with no
 * loading state at all — which is both faster to use and one fewer state to
 * design. The search index is the opposite case and is loaded lazily; see
 * search.jsx.
 */
import {useCallback, useEffect, useMemo, useState} from 'react';
import {FLAT, NAV, SIDEBAR, SITE} from './nav.js';
import {mdxComponents} from './mdx.jsx';
import {SearchPalette} from './search.jsx';
import {
  Close,
  Github,
  Menu,
  Moon,
  Pencil,
  Search as SearchIcon,
  Sun,
} from './icons.jsx';
import './styles.css';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const LOGO = `${BASE}/logo.png`;

const PAGES = import.meta.glob('../content/**/*.mdx', {eager: true});

/** ../content/guide/player.mdx → /guide/player  ·  ../content/index.mdx → / */
const BY_ROUTE = Object.fromEntries(
  Object.entries(PAGES).map(([file, mod]) => [
    file.replace('../content', '').replace(/\.mdx$/, '').replace(/\/index$/, '') ||
      '/',
    mod,
  ]),
);

/* ── Routing ─────────────────────────────────────────────────────────────── */

const toPath = url => {
  const p = url.replace(BASE, '') || '/';
  return p.replace(/\/$/, '') || '/';
};

function useRouter() {
  const [path, setPath] = useState(() => toPath(window.location.pathname));

  const navigate = useCallback(to => {
    const [p, hash] = to.split('#');
    const clean = p.replace(/\/$/, '') || '/';
    // The hash goes in the URL even when the path has not changed, so a link
    // followed to a section on the page you are already on is still a link you
    // can copy, and Back still undoes it.
    const url = `${BASE}${clean === '/' ? '/' : clean}${hash ? `#${hash}` : ''}`;
    const changed = toPath(window.location.pathname) !== clean;
    if (window.location.pathname + window.location.hash !== url) {
      window.history.pushState({}, '', url);
    }
    if (changed) {
      setPath(clean);
    }
    // Let the new page commit before hunting for the anchor in it.
    requestAnimationFrame(() => {
      const el = hash && document.getElementById(hash);
      if (el) {
        el.scrollIntoView();
        return;
      }
      // behavior: 'instant', and it has to be spelled out. `html` carries
      // scroll-behavior: smooth so that in-page anchors glide, and a plain
      // scrollTo(0, 0) inherits it: following Next from the foot of a long
      // page ANIMATED all the way back up through content that had already
      // been replaced, which is the new page appearing to scroll in from its
      // bottom. A different page is not somewhere you travelled to.
      //
      // Overriding the style on <html> first does NOT work - measured. The
      // inline write does not force a style flush, so scrollTo still reads
      // the smooth value and animates anyway. The option on the call is read
      // directly and is the only form that lands.
      window.scrollTo({top: 0, left: 0, behavior: 'instant'});
    });
  }, []);

  useEffect(() => {
    const onPop = () => setPath(toPath(window.location.pathname));
    window.addEventListener('popstate', onPop);

    // One delegated listener instead of a <Link> component: MDX content is
    // plain markdown, and its links are plain <a>. Intercepting here means
    // every internal link in every page routes without the content knowing.
    const onClick = e => {
      const a = e.target.closest?.('a');
      if (
        !a ||
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        a.target === '_blank' ||
        a.hasAttribute('download')
      ) {
        return;
      }
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('/') || href.startsWith('//')) {
        return;
      }
      e.preventDefault();
      navigate(href);
    };
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('click', onClick);
    };
  }, [navigate]);

  return [path, navigate];
}

/* ── Theme ───────────────────────────────────────────────────────────────── */

function useTheme() {
  // The inline script in index.html always stamps data-theme before first
  // paint, from storage or from the system preference, so this reads one
  // attribute rather than re-deriving the same answer a second way.
  const [theme, setTheme] = useState(
    () => document.documentElement.dataset.theme || 'dark',
  );

  const toggle = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('fm-theme', next);
      } catch {
        // Private windows and blocked site data both throw here. The toggle
        // still works for this visit; it just will not be remembered.
      }
      return next;
    });
  }, []);

  return [theme === 'dark', toggle];
}

/* ── On this page ────────────────────────────────────────────────────────── */

function Toc({path}) {
  const [items, setItems] = useState([]);
  const [active, setActive] = useState('');

  useEffect(() => {
    const nodes = [...document.querySelectorAll('.prose h2, .prose h3')].filter(
      n => n.id,
    );
    setItems(nodes.map(n => ({id: n.id, text: n.textContent, level: +n.tagName[1]})));
    setActive(nodes[0]?.id ?? '');

    if (!nodes.length || typeof IntersectionObserver === 'undefined') {
      return;
    }
    // A band across the top of the viewport: the heading nearest the top of
    // what you are reading is the one you are reading, which is not the same as
    // the one that happens to be most visible.
    const io = new IntersectionObserver(
      entries => {
        const onScreen = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (onScreen.length) {
          setActive(onScreen[0].target.id);
        }
      },
      {rootMargin: '-72px 0px -72% 0px'},
    );
    nodes.forEach(n => io.observe(n));
    return () => io.disconnect();
  }, [path]);

  if (items.length < 2) {
    return <aside className="toc" />;
  }

  return (
    <aside className="toc">
      <div className="toc-inner">
        <p className="toc-title">On this page</p>
        {items.map(i => (
          <a
            key={i.id}
            href={`#${i.id}`}
            className={`${i.level === 3 ? 'lvl-3 ' : ''}${active === i.id ? 'on' : ''}`}>
            {i.text}
          </a>
        ))}
      </div>
    </aside>
  );
}

/* ── Sidebar ─────────────────────────────────────────────────────────────── */

function Sidebar({path, onPick}) {
  return (
    <nav aria-label="Documentation">
      {SIDEBAR.map(group => (
        <div className="side-group" key={group.text}>
          <p className="side-title">{group.text}</p>
          {group.items.map(item => (
            <a
              key={item.link}
              href={item.link}
              className={`side-link${path === item.link ? ' on' : ''}`}
              aria-current={path === item.link ? 'page' : undefined}
              onClick={onPick}>
              {item.text}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

/* ── Page footer ─────────────────────────────────────────────────────────── */

function Pager({path}) {
  const i = FLAT.findIndex(p => p.link === path);
  if (i < 0) {
    return null;
  }
  const prev = FLAT[i - 1];
  const next = FLAT[i + 1];
  return (
    <nav className="pager" aria-label="Nearby pages">
      {prev ? (
        <a className="prev" href={prev.link} aria-label={`Previous: ${prev.text}`}>
          <span className="dir" aria-hidden="true">←</span>
          <span className="name">{prev.text}</span>
        </a>
      ) : (
        <span />
      )}
      {next && (
        <a className="next" href={next.link} aria-label={`Next: ${next.text}`}>
          <span className="name">{next.text}</span>
          <span className="dir" aria-hidden="true">→</span>
        </a>
      )}
    </nav>
  );
}

/* ── App ─────────────────────────────────────────────────────────────────── */

export default function App() {
  const [path, navigate] = useRouter();
  const [dark, toggleTheme] = useTheme();
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState(false);

  const page = BY_ROUTE[path];
  const meta = FLAT.find(p => p.link === path);
  const isHome = path === '/';

  // Title follows the route, because a tab you left open should say which page
  // it is rather than which site.
  useEffect(() => {
    document.title = meta
      ? `${meta.text} | ${SITE.name}`
      : `${SITE.name} — Documentation`;
  }, [meta]);

  useEffect(() => setDrawer(false), [path]);

  // Ctrl/⌘-K anywhere, and "/" when you are not already typing.
  useEffect(() => {
    const onKey = e => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) ||
          (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName))) {
        e.preventDefault();
        setSearch(true);
      }
      if (e.key === 'Escape') {
        setDrawer(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // The page behind the drawer must not scroll under it.
  useEffect(() => {
    if (!drawer) {
      return;
    }
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawer]);

  // No scroll-reveal on documentation pages, deliberately. Fading paragraphs in
  // as they arrive answers no question — nothing changed, you scrolled — and it
  // actively fights reading: the line you are moving toward is the one that is
  // not there yet. It belongs on a landing page, not on a reference.

  const Body = useMemo(() => page?.default, [page]);
  const activeTop = NAV.find(n => path.startsWith(n.match));

  return (
    <>
      <header className="hdr">
        <button
          type="button"
          className="icon-btn burger"
          aria-label="Open the navigation"
          aria-expanded={drawer}
          onClick={() => setDrawer(v => !v)}>
          <Menu />
        </button>

        <a className="brand" href="/">
          <img src={LOGO} alt="" width="30" height="30" />
          {SITE.name}
        </a>

        <div className="hdr-mid">
          <button
            type="button"
            className="search-btn"
            aria-label="Search the documentation"
            onClick={() => setSearch(true)}>
            <SearchIcon />
            <span>Search</span>
            <kbd>Ctrl K</kbd>
          </button>
        </div>

        <div className="hdr-right">
          <div className="hdr-links">
            {NAV.map(n => (
              <a
                key={n.link}
                href={n.link}
                className={activeTop === n ? 'on' : undefined}>
                {n.text}
              </a>
            ))}
            <a href={SITE.releases} target="_blank" rel="noreferrer">
              Download
              <span className="ext" aria-hidden="true">
                ↗
              </span>
            </a>
          </div>

          <span className="hdr-sep" />

          <button
            type="button"
            className={`theme-switch${dark ? ' dark' : ''}`}
            role="switch"
            aria-checked={dark}
            aria-label="Dark theme"
            title={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}
            onClick={toggleTheme}>
            <span className="theme-knob">
              {dark ? <Moon size={12} /> : <Sun size={12} />}
            </span>
          </button>

          <a
            className="icon-btn"
            href={SITE.repo}
            target="_blank"
            rel="noreferrer"
            aria-label="Source on GitHub">
            <Github />
          </a>
        </div>
      </header>

      <div
        className={`scrim${drawer ? ' on' : ''}`}
        onClick={() => setDrawer(false)}
        aria-hidden="true"
      />
      <aside
        className={`drawer${drawer ? ' on' : ''}`}
        inert={drawer ? undefined : 'true'}>
        <div className="drawer-head">
          <a className="brand" href="/">
            <img src={LOGO} alt="" width="30" height="30" />
            {SITE.name}
          </a>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close the navigation"
            onClick={() => setDrawer(false)}>
            <Close />
          </button>
        </div>
        <Sidebar path={path} onPick={() => setDrawer(false)} />
      </aside>

      {isHome ? (
        <main className="home">
          {Body && <Body components={mdxComponents} />}
        </main>
      ) : (
        <div className="shell">
          <aside className="side">
            <Sidebar path={path} />
          </aside>

          <main className="doc">
            <div className="doc-inner">
              <article className="prose">
                {Body ? (
                  <Body components={mdxComponents} />
                ) : (
                  <>
                    <h1>Page not found</h1>
                    <p>
                      There is no page at <code>{path}</code>. It may have been
                      renamed — the sidebar has everything the site knows about.
                    </p>
                    <p>
                      <a href="/guide/introduction">Start at the introduction →</a>
                    </p>
                  </>
                )}
              </article>

              {meta && (
                <>
                  <a
                    className="edit"
                    href={`${SITE.editBase}${path}.mdx`}
                    target="_blank"
                    rel="noreferrer">
                    <Pencil />
                    Suggest an edit to this page
                  </a>
                  <Pager path={path} />
                </>
              )}
            </div>
          </main>

          <Toc path={path} />
        </div>
      )}

      <footer className="foot">
        <p>
          <a href={SITE.repo} target="_blank" rel="noreferrer">
            Source
          </a>{' '}
          ·{' '}
          <a href={SITE.allReleases} target="_blank" rel="noreferrer">
            Releases
          </a>{' '}
          ·{' '}
          <a href={SITE.issues} target="_blank" rel="noreferrer">
            Report a problem
          </a>{' '}
          ·{' '}
          <a href="/fair-use">Fair use</a>{' '}
          ·{' '}
          <a href="/licence">Licence</a>
        </p>
        {/* The affiliation disclaimer belongs on Fair Use, where it is stated
            once with the reasoning around it. Repeating it under every page of
            a reference site is noise on 20 pages to make a point on one. */}
        <p>For educational and personal use.</p>
      </footer>

      <SearchPalette
        open={search}
        onClose={() => setSearch(false)}
        onNavigate={navigate}
      />
    </>
  );
}
