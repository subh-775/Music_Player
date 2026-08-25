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

export const Github = p => (
  <svg viewBox="0 0 24 24" width={p.size || 19} height={p.size || 19} aria-hidden="true" fill="currentColor">
    <path d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.8 2.7 1.3 3.4 1 .1-.7.4-1.3.7-1.5-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C17.1 5 18.1 5.3 18.1 5.3c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.2c0 .4.2.7.8.6A11.5 11.5 0 0 0 12 .5Z" />
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
