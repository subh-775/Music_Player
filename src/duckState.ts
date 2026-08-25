/**
 * Who paused the music: ducking, or the user?
 *
 * Audio focus is lost and regained constantly (a notification chime, a
 * navigation prompt, a call ending). The duck handler must only resume playback
 * that IT paused — resuming on any focus regain is how a chime ends up starting
 * music the user had deliberately stopped.
 *
 * It lives in its own module because both the playback service (which handles
 * the focus events) and the player (which handles the in-app transport) have to
 * agree on it, and importing one from the other would be a cycle.
 */
let pausedByDuck = false;

export function setPausedByDuck(value: boolean): void {
  pausedByDuck = value;
}

export function wasPausedByDuck(): boolean {
  return pausedByDuck;
}
