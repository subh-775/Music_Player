/**
 * One source of truth for the site's shape.
 *
 * The sidebar, the header, prev/next at the foot of every page, the edit link
 * and the list of HTML files the build emits all read from here. A page added
 * in one place and forgotten in four others is the standard way a docs site
 * rots, so there is only the one place.
 */

/** owner/name once, so a rename or a fork is one edit rather than six. */
const SLUG = 'subh-775/Music_Player';

export const SITE = {
  name: 'Fix_Music',
  tagline: 'An Android music player that searches three catalogues as one',
  slug: SLUG,
  repo: `https://github.com/${SLUG}`,
  releases: `https://github.com/${SLUG}/releases/latest`,
  allReleases: `https://github.com/${SLUG}/releases`,
  issues: `https://github.com/${SLUG}/issues`,
  api: `https://api.github.com/repos/${SLUG}`,
  /** Where "Suggest an edit" points. The page path is appended. */
  editBase: `https://github.com/${SLUG}/edit/mobile/docs/content`,
};

/** Top-of-page links. `match` decides which one is lit. */
export const NAV = [
  {text: 'Guide', link: '/guide/introduction', match: '/guide/'},
  {text: 'Reference', link: '/reference/settings', match: '/reference/'},
  {text: 'Releases', link: '/releases', match: '/releases'},
];

export const SIDEBAR = [
  {
    text: 'Getting Started',
    items: [
      {text: 'Introduction', link: '/guide/introduction'},
      {text: 'Installation', link: '/guide/installation'},
      {text: 'Quick Start', link: '/guide/quick-start'},
    ],
  },
  {
    text: 'Core Features',
    items: [
      {text: 'Finding Music', link: '/guide/finding-music'},
      {text: 'The Player', link: '/guide/player'},
      {text: 'Gestures', link: '/guide/gestures'},
      {text: 'The Queue', link: '/guide/queue'},
      {text: 'Equalizer', link: '/guide/equalizer'},
      {text: 'Lyrics', link: '/guide/lyrics'},
      {text: 'Spotify Import', link: '/guide/spotify-import'},
      {text: 'Your Library', link: '/guide/library'},
      {text: 'Downloads & Offline', link: '/guide/downloads'},
    ],
  },
  {
    text: 'Reference',
    items: [
      {text: 'Settings', link: '/reference/settings'},
      {text: 'Sound & Quality', link: '/reference/sound'},
      {text: 'Updates', link: '/reference/updates'},
      {text: 'Data & Storage', link: '/reference/architecture'},
      {text: 'Troubleshooting', link: '/reference/troubleshooting'},
    ],
  },
  {
    text: 'Project',
    items: [
      {text: 'Releases', link: '/releases'},
      {text: 'Fair Use', link: '/fair-use'},
      {text: 'Licence', link: '/licence'},
    ],
  },
];

/** Every documented page in reading order — what prev/next walks. */
export const FLAT = SIDEBAR.flatMap(group =>
  group.items.map(item => ({...item, group: group.text})),
);

/** Every route the site serves, home included. The build emits one real HTML
 *  file per entry so deep links are 200s rather than a 404 handler. */
export const ROUTES = ['/', ...FLAT.map(p => p.link)];

/** The MDX file behind a route. `/` is content/index.mdx. */
export function sourceFor(path) {
  return path === '/' ? '/index' : path;
}
