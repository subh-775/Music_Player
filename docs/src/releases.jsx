/**
 * The latest release, read from GitHub at view time.
 *
 * This was a list of every version, and the list restated notes that are
 * already written properly on the release itself. Worse, CI generates those
 * bodies, so "the first line of the notes" is a compare URL — nine rows of
 * `…compare/v1.0.15...v1.0.16` and no information in any of them.
 *
 * One row, four facts, and a link to the rest.
 */
import {useEffect, useState} from 'react';
import {SITE} from './nav.js';

const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function LatestRelease() {
  const [release, setRelease] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`${SITE.api}/releases/latest`, {
      headers: {Accept: 'application/vnd.github+json'},
    })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error('http'))))
      .then(json => alive && setRelease(json))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  // Unauthenticated GitHub requests are rate limited per IP, so this is a
  // normal outcome rather than an error worth apologising for.
  if (failed) {
    return (
      <p className="rel-fallback">
        <a href={SITE.releases} target="_blank" rel="noreferrer">
          The latest release is on GitHub
        </a>
        .
      </p>
    );
  }

  if (!release) {
    return <div className="rel-badge rel-badge-skel" aria-busy="true" />;
  }

  const apk = (release.assets || []).find(a => a.name.endsWith('.apk'));
  const downloads = (release.assets || []).reduce(
    (n, a) => n + (a.download_count || 0),
    0,
  );

  return (
    <a
      className="rel-badge"
      href={release.html_url}
      target="_blank"
      rel="noreferrer">
      <span className="rel-cell">
        <b>Latest</b>
        <span>{release.tag_name}</span>
      </span>
      <span className="rel-cell">
        <b>Published</b>
        <span>
          {release.published_at
            ? DATE.format(new Date(release.published_at))
            : '—'}
        </span>
      </span>
      <span className="rel-cell">
        <b>Size</b>
        <span>{apk ? `${(apk.size / 1048576).toFixed(1)} MB` : '—'}</span>
      </span>
      <span className="rel-cell">
        <b>Downloads</b>
        <span>{downloads.toLocaleString('en-GB')}</span>
      </span>
    </a>
  );
}
