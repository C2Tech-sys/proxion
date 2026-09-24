import { describe, expect, it } from 'vitest';
import { desEncryptBlock, reverseBits, vncAuthResponse, vncDesKey } from '../src/console/des.js';

describe('DES (pure-TS, FIPS 46-3)', () => {
  it('matches the canonical FIPS test vector', () => {
    // key = 0x133457799BBCDFF1, plaintext = 0x0123456789ABCDEF -> ciphertext = 0x85E813540F0AB405.
    // This is the single most widely published DES known-answer test vector
    // (used throughout textbooks and reference implementations), independent
    // of anything in this repo -- a strong external check on the whole
    // permutation/S-box/key-schedule pipeline, not just one table.
    const key = Buffer.from('133457799BBCDFF1', 'hex');
    const plaintext = Buffer.from('0123456789ABCDEF', 'hex');
    const ciphertext = desEncryptBlock(key, plaintext);
    expect(ciphertext.toString('hex').toUpperCase()).toBe('85E813540F0AB405');
  });

  it('matches a second independent known-answer vector (all-zero key/plaintext)', () => {
    const key = Buffer.from('0000000000000000', 'hex');
    const plaintext = Buffer.from('0000000000000000', 'hex');
    const ciphertext = desEncryptBlock(key, plaintext);
    expect(ciphertext.toString('hex').toUpperCase()).toBe('8CA64DE9C1B123A7');
  });

  it('round-trips are internally consistent: encrypting is deterministic and key-sensitive', () => {
    const plaintext = Buffer.from('0123456789ABCDEF', 'hex');
    const a = desEncryptBlock(Buffer.from('133457799BBCDFF1', 'hex'), plaintext);
    const b = desEncryptBlock(Buffer.from('133457799BBCDFF1', 'hex'), plaintext);
    const c = desEncryptBlock(Buffer.from('0000000000000000', 'hex'), plaintext);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it('rejects non-8-byte keys or blocks', () => {
    expect(() => desEncryptBlock(Buffer.alloc(7), Buffer.alloc(8))).toThrow();
    expect(() => desEncryptBlock(Buffer.alloc(8), Buffer.alloc(9))).toThrow();
  });
});

describe('VNC Authentication key mangling', () => {
  it('reverseBits reverses the bit order of a byte', () => {
    expect(reverseBits(0b00000001)).toBe(0b10000000);
    expect(reverseBits(0b10000000)).toBe(0b00000001);
    expect(reverseBits(0b00001111)).toBe(0b11110000);
    expect(reverseBits(0b00000000)).toBe(0);
    expect(reverseBits(0b11111111)).toBe(0b11111111);
  });

  it('vncDesKey takes the first 8 bytes of the password, each bit-reversed', () => {
    const key = vncDesKey('AAAAAAAA'); // 'A' = 0x41 = 01000001 -> reversed = 10000010 = 0x82
    expect(key.equals(Buffer.from('8282828282828282', 'hex'))).toBe(true);
  });

  it('vncDesKey zero-pads a short password and truncates a long one', () => {
    const short = vncDesKey('A'); // 0x41 reversed = 0x82, then seven zero bytes
    expect(short.equals(Buffer.from('8200000000000000', 'hex'))).toBe(true);

    const long = vncDesKey('AAAAAAAAAAAA'); // only the first 8 bytes matter
    expect(long.equals(vncDesKey('AAAAAAAA'))).toBe(true);
  });

  it('vncAuthResponse encrypts the 16-byte challenge as two independent 8-byte ECB blocks', () => {
    const challenge = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const response = vncAuthResponse('secretpw', challenge);
    expect(response).toHaveLength(16);

    const key = vncDesKey('secretpw');
    const expected = Buffer.concat([
      desEncryptBlock(key, challenge.subarray(0, 8)),
      desEncryptBlock(key, challenge.subarray(8, 16)),
    ]);
    expect(response.equals(expected)).toBe(true);
  });

  it('vncAuthResponse rejects a challenge that is not exactly 16 bytes', () => {
    expect(() => vncAuthResponse('pw', Buffer.alloc(15))).toThrow();
    expect(() => vncAuthResponse('pw', Buffer.alloc(17))).toThrow();
  });
});
