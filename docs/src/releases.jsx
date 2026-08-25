/**
 * The release list, read from GitHub at view time.
 *
 * The page used to carry a hand-written table of versions and headlines. That
 * is wrong twice over: it is stale the moment a tag is pushed, and it restates
 * notes that are already written properly on the release itself. Asking the API
 * means the page cannot fall behind the app.
 *
 * Unauthenticated api.github.com allows 60 requests an hour per address and
 * sends CORS headers, which is ample for a documentation page. When it fails —
 * offline, rate limited, repository renamed — the component says so and leaves
 * the link that always works.
 */
import {useEffect, useState} from 'react';
import {SITE} from './nav.js';

const API = `${SITE.api}/releases?per_page=8`;

const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/**
 * One line under the tag: the first real sentence of the notes when a release
 * has them. Several of these were published by CI with an empty body, so the
 * fallback is the thing that is true of every release either way — the file you
 * would download, and how big it is.
 */
function subtitle(release) {
  const line = (release.body || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('#') && !l.startsWith('<!--'));
  if (line) {
    return line.replace(/^[-*]\s*/, '').replace(/[*_`]/g, '').slice(0, 160);
  }
  const apk = (release.assets || []).find(a => a.name.endsWith('.apk'));
  return apk
    ? `${apk.name} · ${(apk.size / 1048576).toFixed(1)} MB`
    : 'Published without notes.';
}

export function ReleaseList() {
  const [state, setState] = useState({status: 'loading', items: []});

  useEffect(() => {
    let alive = true;
    fetch(API, {headers: {Accept: 'application/vnd.github+json'}})
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(items => {
        if (alive) {
          setState({status: 'ok', items});
        }
      })
      .catch(() => {
        if (alive) {
          setState({status: 'error', items: []});
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="rel-list" aria-busy="true">
        {[0, 1, 2].map(i => (
          <div className="rel rel-skel" key={i}>
            <span />
            <span />
          </div>
        ))}
      </div>
    );
  }

  if (state.status === 'error' || !state.items.length) {
    return (
      <p className="rel-fallback">
        The release list could not be loaded — GitHub may be rate limiting this
        address.{' '}
        <a href={SITE.allReleases} target="_blank" rel="noreferrer">
          Every release and its notes are on GitHub
        </a>
        .
      </p>
    );
  }

  return (
    <div className="rel-list">
      {state.items.map((r, i) => (
        <a
          className={`rel${i === 0 ? ' rel-latest' : ''}`}
          key={r.id}
          href={r.html_url}
          target="_blank"
          rel="noreferrer">
          <span className="rel-head">
            <span className="rel-tag">{r.tag_name}</span>
            {i === 0 && <span className="rel-chip">Latest</span>}
            <span className="rel-date">
              {r.published_at ? DATE.format(new Date(r.published_at)) : ''}
            </span>
          </span>
          <span className="rel-note">{subtitle(r)}</span>
        </a>
      ))}
    </div>
  );
}
