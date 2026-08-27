/**
 * Ctrl/⌘-K search, over an index built from the MDX sources themselves.
 *
 * The corpus is one virtual module assembled at build time (searchCorpus in
 * vite.config.js) and imported DYNAMICALLY, so none of it is in the bundle
 * anyone downloads to read a page — it arrives the first time the palette
 * opens, which is the first moment it is worth anything.
 *
 * It is deliberately not `import.meta.glob(..., {query: '?raw'})`, which is the
 * obvious way and is broken here: @mdx-js/rollup strips the query before it
 * decides what to handle, so the raw text came back through the MDX compiler as
 * a component. Every entry threw on `.replace`, the indexing promise rejected,
 * and search returned nothing while saying nothing about why.
 *
 * Scoring is deliberately small: a title hit outranks a heading hit outranks a
 * body hit, and a phrase that appears earlier in a section outranks one that
 * appears later. Twenty pages do not need BM25.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FLAT} from './nav.js';
import {Close, Search as SearchIcon} from './icons.jsx';

/** Markdown and JSX out, readable prose in. */
function plain(md) {
  return md
    .replace(/^---[\s\S]*?---/m, '') // frontmatter
    .replace(/^import .*$/gm, '')
    .replace(/^export .*$/gm, '')
    .replace(/<[^>]*>/g, ' ') // JSX and HTML
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_>|#-]{1,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One entry per heading, so a hit can land on the section rather than the top
 *  of a long page. */
function buildIndex(files) {
  const out = [];
  for (const [route, md] of Object.entries(files)) {
    const page = FLAT.find(p => p.link === route);
    const title = page?.text ?? 'Home';
    const group = page?.group ?? '';

    // Split on ATX headings, keeping the heading with the text under it.
    const parts = md.split(/^(#{1,3})\s+(.+)$/m);
    // parts[0] is whatever preceded the first heading — usually nothing, since
    // pages open with their own title. Only worth an entry when it has text.
    const preamble = plain(parts[0]).slice(0, 600);
    if (preamble) {
      out.push({route, title, group, heading: '', text: preamble});
    }
    for (let i = 1; i < parts.length; i += 3) {
      const heading = parts[i + 1]?.trim() ?? '';
      const body = plain(parts[i + 2] ?? '');
      if (!heading) {
        continue;
      }
      out.push({
        route,
        title,
        group,
        heading,
        hash: heading
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-'),
        text: body.slice(0, 600),
      });
    }
  }
  return out;
}

function score(entry, q) {
  const t = entry.title.toLowerCase();
  const h = entry.heading.toLowerCase();
  const b = entry.text.toLowerCase();
  if (t.includes(q)) {
    return 100 - t.indexOf(q);
  }
  if (h.includes(q)) {
    return 70 - h.indexOf(q);
  }
  const at = b.indexOf(q);
  if (at >= 0) {
    return 40 - Math.min(39, at / 20);
  }
  return 0;
}

/** The matched phrase and the words either side of it, in three pieces so the
 *  middle one can be marked. */
function snippet(text, q) {
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) {
    return [text.slice(0, 130), '', ''];
  }
  const from = Math.max(0, at - 45);
  return [
    (from ? '…' : '') + text.slice(from, at),
    text.slice(at, at + q.length),
    text.slice(at + q.length, at + q.length + 90),
  ];
}

function Snip({text, q}) {
  const [before, hit, after] = snippet(text, q);
  return (
    <span className="pal-snip">
      {before}
      {hit && <mark>{hit}</mark>}
      {after}
    </span>
  );
}

export function SearchPalette({open, onClose, onNavigate}) {
  const [index, setIndex] = useState(null);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef(null);

  // Load and index on first open, once.
  useEffect(() => {
    if (!open || index) {
      return;
    }
    let alive = true;
    import('virtual:docs-corpus').then(m => {
      if (alive) {
        setIndex(buildIndex(m.default));
      }
    });
    return () => {
      alive = false;
    };
  }, [open, index]);

  useEffect(() => {
    if (open) {
      setQ('');
      setCursor(0);
      // The field is the only reason this dialog exists; focus belongs there
      // before the animation has finished.
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !index) {
      return [];
    }
    return index
      .map(e => ({e, s: score(e, needle)}))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map(x => x.e);
  }, [q, index]);

  const go = useCallback(
    hit => {
      onNavigate(hit.hash ? `${hit.route}#${hit.hash}` : hit.route);
      onClose();
    },
    [onNavigate, onClose],
  );

  const onKey = useCallback(
    e => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor(c => Math.min(hits.length - 1, c + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor(c => Math.max(0, c - 1));
      } else if (e.key === 'Enter' && hits[cursor]) {
        e.preventDefault();
        go(hits[cursor]);
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [hits, cursor, go, onClose],
  );

  if (!open) {
    return null;
  }

  return (
    <div
      className="pal-scrim"
      onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="pal" role="dialog" aria-modal="true" aria-label="Search">
        <div className="pal-field">
          <SearchIcon size={18} />
          <input
            ref={input}
            value={q}
            onChange={e => {
              setQ(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKey}
            placeholder="Search the documentation"
            aria-label="Search the documentation"
          />
          {/* Two affordances for one action, and only one of them is ever
              true. A keyboard has an Esc key and the chip names it; a phone has
              neither, so the chip there is a label for a key that does not
              exist AND it is not tappable. Which one shows is decided in CSS,
              at the same width the header swaps its search box for an icon. */}
          <kbd className="pal-esc">Esc</kbd>
          <button
            type="button"
            className="pal-close"
            onClick={onClose}
            aria-label="Close search">
            <Close size={20} />
          </button>
        </div>

        <div className="pal-list">
          {!q.trim() && (
            <p className="pal-empty">
              {index
                ? 'Try “crossfade”, “download” or “equalizer”.'
                : 'Building the index…'}
            </p>
          )}
          {q.trim() && !hits.length && (
            <p className="pal-empty">
              Nothing matches “{q.trim()}”. Try a shorter word.
            </p>
          )}
          {hits.map((hit, i) => (
            <a
              key={`${hit.route}${hit.hash ?? ''}${i}`}
              href={hit.route}
              className={`pal-hit${i === cursor ? ' on' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={e => {
                e.preventDefault();
                go(hit);
              }}>
              <span className="pal-crumb">
                {hit.group ? `${hit.group} · ` : ''}
                {hit.title}
              </span>
              <span className="pal-name">{hit.heading || hit.title}</span>
              {hit.text && <Snip text={hit.text} q={q.trim().toLowerCase()} />}
            </a>
          ))}
        </div>

        <div className="pal-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
