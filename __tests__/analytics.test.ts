/**
 * An identical event within two seconds is dropped as a repeat; anything
 * different, or the same thing later, still goes through.
 */
import {expect, jest, test} from '@jest/globals';

jest.mock('react-native', () => ({
  NativeModules: {Analytics: {log: jest.fn()}},
}));

// NB: below the mock — jest hoists jest.mock().
import {NativeModules} from 'react-native';
import {logEvent} from '../src/analytics';

const mockLog = NativeModules.Analytics.log as jest.Mock;

test('a repeat within the window is dropped, a change or a later repeat is not', () => {
  const now = jest.spyOn(Date, 'now');
  now.mockReturnValue(1000);
  logEvent('song_played', {title: 'A'});
  now.mockReturnValue(1300);
  logEvent('song_played', {title: 'A'}); // the engine's double event
  expect(mockLog).toHaveBeenCalledTimes(1);
  logEvent('song_played', {title: 'B'}); // a different song
  expect(mockLog).toHaveBeenCalledTimes(2);
  now.mockReturnValue(9000);
  logEvent('song_played', {title: 'B'}); // played again, much later
  expect(mockLog).toHaveBeenCalledTimes(3);
});
