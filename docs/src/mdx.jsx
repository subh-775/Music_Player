/**
 * What MDX renders its markdown into.
 *
 * Two things are handled here rather than in the content: tables get a
 * scrolling wrapper (a wide table must scroll inside its own box, never make
 * the page scroll sideways), and headings get a hover anchor so any section can
 * be linked to without hunting for an id.
 *
 * The callouts are components rather than a markdown extension so their shape
 * lives in one place — see the note on `.callout` in styles.css for why they
 * are a tinted field and not the usual coloured rail down the left edge.
 */
import {AppMark, GestureGrid, ReleaseBadges, SeekDemo} from './demos.jsx';
import {External, Link as LinkIcon} from './icons.jsx';

function heading(Tag) {
  return function Heading({id, children, ...rest}) {
    return (
      <Tag id={id} {...rest}>
        {id && (
          <a className="anchor" href={`#${id}`} aria-label="Link to this section">
            <LinkIcon size={14} />
          </a>
        )}
        {children}
      </Tag>
    );
  };
}

function Table(props) {
  return (
    <div className="tablewrap">
      <table {...props} />
    </div>
  );
}

/** External links say so. An arrow is cheaper than a paragraph explaining that
 *  this one leaves the site. */
function Anchor({href = '', children, ...rest}) {
  const external = /^https?:/.test(href);
  return (
    <a
      href={href}
      {...(external ? {target: '_blank', rel: 'noreferrer'} : null)}
      {...rest}>
      {children}
      {external && <External size={12} />}
    </a>
  );
}

function callout(kind, label) {
  return function Callout({title, children}) {
    return (
      <div className={`callout callout-${kind}`}>
        <span className="callout-label">{title || label}</span>
        {children}
      </div>
    );
  };
}

export const Tip = callout('tip', 'Tip');
export const Note = callout('info', 'Note');
export const Warn = callout('warn', 'Worth knowing');
export const Danger = callout('danger', 'This one matters');

export const mdxComponents = {
  h2: heading('h2'),
  h3: heading('h3'),
  table: Table,
  a: Anchor,
  Tip,
  Note,
  Warn,
  Danger,
  AppMark,
  SeekDemo,
  GestureGrid,
  ReleaseBadges,
};
