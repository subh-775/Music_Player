/**
 * The two-level "+" that replaced the ⊕ and the ♥ in both players.
 *
 * Not liked  → tap → liked, and the glyph fills. The common action, one press,
 *              no sheet in the way.
 * Liked      → tap → the "Saved in" sheet, for everything that is not Liked
 *              Songs.
 * Either     → long press → straight to the sheet, so wanting a playlist does
 *              not mean liking the song first and then unliking it.
 *
 * The glyph MUST change on the first press, or the second press reads as the
 * first one having failed — which is the way a control with two levels usually
 * goes wrong.
 *
 * One component rather than the same logic in the player and the mini player,
 * because two copies of a two-level control is two chances for them to end up
 * disagreeing about what the second press does.
 */
import React, {useCallback} from 'react';
import {StyleProp, TouchableOpacity, ViewStyle} from 'react-native';
import {CircleCheck, CirclePlus} from 'lucide-react-native';
import {C} from '../theme';
import type {Track} from '../backend';
import {useLike} from '../store';
import {toast} from '../toast';

export function AddButton({
  track,
  onOpenSheet,
  size = 25,
  style,
  hitSlop = 8,
}: {
  track: Track | null;
  onOpenSheet: (t: Track) => void;
  size?: number;
  style?: StyleProp<ViewStyle>;
  hitSlop?: number;
}) {
  const {liked, toggle} = useLike(track);

  const onPress = useCallback(() => {
    if (!track) {
      return;
    }
    if (!liked) {
      toggle();
      toast('Added to Liked Songs');
      return;
    }
    onOpenSheet(track);
  }, [track, liked, toggle, onOpenSheet]);

  const onLongPress = useCallback(() => {
    if (track) {
      onOpenSheet(track);
    }
  }, [track, onOpenSheet]);

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={
        liked ? 'Saved. Open the list of playlists' : 'Add to Liked Songs'
      }
      style={style}>
      {liked ? (
        // Stroke in the GROUND colour over an accent fill. Lucide draws the
        // tick as a stroke, so a stroke width of 0 would leave an empty disc
        // and colouring it with the accent would put a green tick on a green
        // circle. The same stroke gives the disc a fine dark rim, which is
        // what keeps it from bleeding into an accent-coloured background.
        <CircleCheck
          size={size}
          color={C.bg}
          fill={C.accent}
          strokeWidth={2.4}
        />
      ) : (
        <CirclePlus size={size} color={C.sub} strokeWidth={1.8} />
      )}
    </TouchableOpacity>
  );
}
