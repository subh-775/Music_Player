/**
 * A pushpin, seen face-on.
 *
 * Lucide's `Pin` is drawn at 45°, and at the 12px the library rows use it —
 * filled, in green — the diagonal body reads as a paper plane rather than a
 * pin. Drawn upright, the head-shaft-point silhouette survives being that
 * small, which is the whole job of an icon at badge size.
 *
 * Used in both places pinning appears, so the badge on a row and the "Pin"
 * action in the menu are visibly the same idea.
 */
import React from 'react';
import Svg, {Path, Rect} from 'react-native-svg';

export function PinGlyph({size = 12, color}: {size?: number; color: string}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {/* Head and shoulders: the flat top, then the taper down to the shaft. */}
      <Path d="M9 2h6v2l-1 1v5l3 3v2H7v-2l3-3V5L9 4V2Z" fill={color} />
      {/* The pin itself. */}
      <Rect x="11.2" y="15" width="1.6" height="7" rx="0.8" fill={color} />
    </Svg>
  );
}
