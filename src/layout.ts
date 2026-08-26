/**
 * How much room the floating bottom bars need at the end of a scrolling list.
 *
 * The mini player and the tab bar are OUT of layout flow (see App.tsx): they
 * are pinned over the page rather than sitting under it, which is what lets
 * content pass behind the mini player's rounded edges and under the tab bar —
 * the reason either of them can be translucent at all. In flow they had nothing
 * behind them to show through, and the strip beside the floating bar was a
 * black band.
 *
 * The cost of taking them out of flow is that every scrolling surface has to
 * end this far above the bottom, or its last row sits behind them permanently.
 *
 * One number rather than one per state: the mini player is only up when
 * something is playing, and reserving its height either way leaves a little
 * extra space at the very end of a list when nothing is. That is invisible in
 * use, and it costs nothing — unlike a value that changes under a list mid
 * scroll, which moves the content under the reader's thumb.
 *
 * Measured, not guessed: PlayerBar is a 54px cover + 5px padding either side +
 * an 8px margin = 72, and BottomNav is 23px icons + 9px padding either side +
 * a 4px label gap + 4px = 61.
 */
export const BOTTOM_INSET = 136;
