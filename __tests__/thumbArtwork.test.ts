import {describe, expect, it} from '@jest/globals';

import {thumbArtwork} from '../src/tracks';

describe('thumbArtwork', () => {
  it('drops a JioSaavn 500x500 cover to list size', () => {
    expect(
      thumbArtwork('https://c.saavncdn.com/123/Song-Hindi-2020-20200101500x500.jpg'),
    ).toContain('150x150');
  });

  it('drops an iTunes 600x600bb cover to list size', () => {
    expect(thumbArtwork('https://is1.mzstatic.com/image/thumb/a/600x600bb.jpg')).toBe(
      'https://is1.mzstatic.com/image/thumb/a/200x200bb.jpg',
    );
  });

  it('never enlarges a cover that is already small', () => {
    expect(thumbArtwork('https://x/50x50.jpg')).toBe('https://x/50x50.jpg');
    expect(thumbArtwork('https://x/100x100bb.jpg')).toBe('https://x/100x100bb.jpg');
  });

  it('does not mangle a bb suffix into a partial match', () => {
    // The backtracking case the single-pass regex exists to prevent.
    expect(thumbArtwork('https://x/200x200bb.jpg')).toBe('https://x/200x200bb.jpg');
  });

  it('leaves a URL with no size template alone', () => {
    expect(thumbArtwork('https://x/cover.jpg')).toBe('https://x/cover.jpg');
  });

  it('is safe on empty input', () => {
    expect(thumbArtwork()).toBe('');
    expect(thumbArtwork('')).toBe('');
  });
});
