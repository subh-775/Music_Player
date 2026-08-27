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
 * The official mark, taken from @primer/octicons rather than reproduced.
 *
 * Two wrong versions preceded this one, and the second is the instructive one.
 * The first swept most of the way round the circle and then closed with `Z`,
 * which drew a chord straight back across the bottom — a disc with a slice out
 * of it. The replacement fixed that and was still wrong: it traversed the outer
 * circle ANTICLOCKWISE, and the cat's inner contours are wound to be counters
 * of a clockwise one. Under the nonzero fill rule that inverts the whole mark —
 * the disc fills and the cat becomes a hole in it, which is what "the logo is
 * cut" actually was.
 *
 * It is not reproduced from memory again. This is the published path, fetched
 * and pasted, and the only safe way to carry a logo someone else owns.
 */
export const Github = p => (
  <svg
    viewBox="0 0 16 16"
    width={p.size || 19}
    height={p.size || 19}
    aria-hidden="true"
    fill="currentColor">
    <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
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
