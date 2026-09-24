import { describe, expect, it } from 'vitest';

import { encodeInputFrame, encodePingFrame, encodeResizeFrame, utf8ByteLength } from './term-framing';

describe('utf8ByteLength', () => {
  it('counts ASCII text as one byte per character', () => {
    expect(utf8ByteLength('abc')).toBe(3);
  });

  it('counts multibyte characters by their UTF-8 encoding, not UTF-16 length', () => {
    // "é" is 2 bytes in UTF-8 but 1 UTF-16 code unit.
    expect(utf8ByteLength('é')).toBe(2);
    // "€" is 3 bytes in UTF-8.
    expect(utf8ByteLength('€')).toBe(3);
    // An emoji outside the BMP is a UTF-16 surrogate pair (length 2) but 4 UTF-8 bytes.
    expect('😀'.length).toBe(2);
    expect(utf8ByteLength('😀')).toBe(4);
  });

  it('returns 0 for an empty string', () => {
    expect(utf8ByteLength('')).toBe(0);
  });
});

describe('encodeInputFrame', () => {
  it('frames ASCII input with its byte length', () => {
    expect(encodeInputFrame('ls -la\r')).toBe('0:7:ls -la\r');
  });

  it('uses the UTF-8 byte length for multibyte input, not the string length', () => {
    expect(encodeInputFrame('café')).toBe('0:5:café');
  });
});

describe('encodeResizeFrame', () => {
  it('frames cols/rows with a trailing colon', () => {
    expect(encodeResizeFrame(80, 24)).toBe('1:80:24:');
  });

  it('reflects a different terminal size after a fit/resize', () => {
    expect(encodeResizeFrame(120, 40)).toBe('1:120:40:');
  });
});

describe('encodePingFrame', () => {
  it('is the literal "2"', () => {
    expect(encodePingFrame()).toBe('2');
  });
});
