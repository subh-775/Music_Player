/**
 * Turning a GitHub release into the two lines the update prompt can show.
 *
 * Its own file rather than sitting inside UpdateModal, because these are pure
 * string and number functions with a real edge case each, and reaching them
 * from a test through the component meant mocking AsyncStorage, the gesture
 * handler's native module and Reanimated to exercise a regex.
 */

/**
 * The release body, minus the machine-generated tail.
 *
 * CI writes bodies that are literally
 * "Full Changelog: https://github.com/.../compare/v1.0.15...v1.0.16", so the
 * prompt's one piece of prose was a URL nobody can tap. What survives is either
 * real notes or nothing — and nothing must render as nothing, rather than as an
 * empty line holding vertical space.
 */
export function readableNotes(body: string): string {
  return (body || '')
    .split('\n')
    .filter(l => !/^\s*(full changelog|what's changed)\s*:?/i.test(l))
    .filter(l => !/^https?:\/\//.test(l.trim()))
    .map(l => l.replace(/^\s*[-*]\s+/, '• '))
    .join('\n')
    .trim();
}

/**
 * "47.6 MB", or empty when the size is unknown so the caller renders nothing.
 *
 * One decimal below 100 MB and none above it: the tenth of a megabyte matters
 * when you are deciding whether to spend mobile data on 47.6, and is noise at
 * 470.
 */
export function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) {
    return '';
  }
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}
