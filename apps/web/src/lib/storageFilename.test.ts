import { describe, expect, it } from 'vitest';
import { validateStorageFilename } from './storageFilename';

describe('validateStorageFilename', () => {
  describe('character rule', () => {
    it('rejects an empty filename', () => {
      expect(validateStorageFilename('iso', '')).toMatch(/must start with a letter or digit/);
    });

    it('rejects a filename with a space', () => {
      expect(validateStorageFilename('iso', 'bad name.iso')).toMatch(/must start with a letter or digit/);
    });

    it('rejects a filename starting with a non-alphanumeric character', () => {
      expect(validateStorageFilename('iso', '-debian.iso')).toMatch(/must start with a letter or digit/);
    });

    it('rejects a filename containing ".."', () => {
      expect(validateStorageFilename('iso', '..%2Fdebian.iso')).toMatch(/must start with a letter or digit/);
    });

    it('rejects a filename over 255 characters', () => {
      expect(validateStorageFilename('iso', `${'a'.repeat(256)}.iso`)).toMatch(/must start with a letter or digit/);
    });
  });

  describe('iso extension rule', () => {
    it('accepts .iso and .img', () => {
      expect(validateStorageFilename('iso', 'debian-12.iso')).toBeNull();
      expect(validateStorageFilename('iso', 'debian-12.img')).toBeNull();
    });

    it('rejects a filename with no extension (the production bug -- "bookworm")', () => {
      expect(validateStorageFilename('iso', 'bookworm')).toBe('ISO images must end in .iso or .img');
    });

    it('rejects an unrelated extension', () => {
      expect(validateStorageFilename('iso', 'debian-12.txt')).toBe('ISO images must end in .iso or .img');
    });
  });

  describe('vztmpl extension rule', () => {
    it('accepts .tar.gz, .tar.xz and .tar.zst', () => {
      expect(validateStorageFilename('vztmpl', 'debian-12-standard.tar.gz')).toBeNull();
      expect(validateStorageFilename('vztmpl', 'debian-12-standard.tar.xz')).toBeNull();
      expect(validateStorageFilename('vztmpl', 'debian-12-standard.tar.zst')).toBeNull();
    });

    it('rejects an unrelated extension (e.g. .zip)', () => {
      expect(validateStorageFilename('vztmpl', 'debian-12-standard.zip')).toBe(
        'Container templates must end in .tar.gz, .tar.xz or .tar.zst',
      );
    });

    it('rejects .tgz (not a rule PVE accepts, despite being a common shorthand)', () => {
      expect(validateStorageFilename('vztmpl', 'debian-12-standard.tgz')).toBe(
        'Container templates must end in .tar.gz, .tar.xz or .tar.zst',
      );
    });
  });

  describe('import extension rule', () => {
    it('accepts .ova, .qcow2, .raw and .vmdk', () => {
      expect(validateStorageFilename('import', 'appliance.ova')).toBeNull();
      expect(validateStorageFilename('import', 'appliance.qcow2')).toBeNull();
      expect(validateStorageFilename('import', 'appliance.raw')).toBeNull();
      expect(validateStorageFilename('import', 'appliance.vmdk')).toBeNull();
    });

    it('rejects an extension valid for a different content type (.iso)', () => {
      expect(validateStorageFilename('import', 'appliance.iso')).toBe(
        'Import files must end in .ova, .qcow2, .raw or .vmdk',
      );
    });
  });
});
