/**
 * Inline SVG, not an icon package.
 *
 * Nine icons do not justify a dependency, a tree-shaking config and a font
 * download. These are drawn on the same 24-unit grid with the same 1.9 stroke,
 * which is what actually makes a set look like a set.
 */
const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export const Search = p => (
  <svg {...base} width={p.size || 17} height={p.size || 17}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.9-3.9" />
  </svg>
);

export const Menu = p => (
  <svg {...base} width={p.size || 20} height={p.size || 20}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </svg>
);

export const Close = p => (
  <svg {...base} width={p.size || 20} height={p.size || 20}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const Sun = p => (
  <svg {...base} width={p.size || 18} height={p.size || 18}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

export const Moon = p => (
  <svg {...base} width={p.size || 18} height={p.size || 18}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8" />
  </svg>
);

/**
 * The official mark, on its own 16-unit grid.
 *
 * What was here before was a hand-simplified octocat whose outer arc never
 * closed: it swept most of the way round and then `Z` drew a chord straight
 * back across the bottom. Filled, that is a disc with a slice taken out of it,
 * which is exactly what it looked like.
 */
export const Github = p => (
  <svg
    viewBox="0 0 16 16"
    width={p.size || 19}
    height={p.size || 19}
    aria-hidden="true"
    fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
);

export const External = p => (
  <svg {...base} width={p.size || 13} height={p.size || 13}>
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
);

export const Pencil = p => (
  <svg {...base} width={p.size || 15} height={p.size || 15}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

export const Download = p => (
  <svg {...base} width={p.size || 17} height={p.size || 17}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5M12 15V3" />
  </svg>
);

export const Link = p => (
  <svg {...base} width={p.size || 15} height={p.size || 15}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L12 5" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19" />
  </svg>
);
