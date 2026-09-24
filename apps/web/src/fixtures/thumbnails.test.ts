import { describe, expect, it } from 'vitest';

import { generateThumbnailPlaceholder } from './thumbnails';

describe('generateThumbnailPlaceholder', () => {
  it('is deterministic: the same guest always produces the same data URI', () => {
    const guest = { vmid: 100, name: 'web-prod-01', ostype: 'l26', status: 'running' };
    expect(generateThumbnailPlaceholder(guest)).toBe(generateThumbnailPlaceholder({ ...guest }));
  });

  it('renders a black tty-style svg for a Linux guest', () => {
    const uri = generateThumbnailPlaceholder({
      vmid: 100,
      name: 'web-prod-01',
      ostype: 'l26',
      status: 'running',
    });
    expect(uri).toMatch(/^data:image\/svg\+xml;utf8,/);
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length));
    expect(svg).toContain('#0a0a0a');
    expect(svg).toContain('web-prod-01');
  });

  it('renders a blue lock-screen svg for a Windows guest (ostype starting with "win")', () => {
    const uri = generateThumbnailPlaceholder({
      vmid: 106,
      name: 'win-dc01',
      ostype: 'win2022',
      status: 'running',
    });
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length));
    expect(svg).toContain('#0078d4');
    expect(svg).toContain('Ctrl+Alt+Del');
  });

  it('renders the Powered off placeholder for a stopped guest, regardless of ostype', () => {
    const uri = generateThumbnailPlaceholder({
      vmid: 103,
      name: 'db-prod-02',
      ostype: 'l26',
      status: 'stopped',
    });
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length));
    expect(svg).toContain('Powered off');
  });

  it('renders the Powered off placeholder for a template, even if status says "running"', () => {
    const uri = generateThumbnailPlaceholder({
      vmid: 110,
      name: 'tpl-ubuntu-2404',
      ostype: 'l26',
      status: 'running',
      template: true,
    });
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length));
    expect(svg).toContain('Powered off');
  });

  it('varies output by vmid (not just a single fixed image)', () => {
    const a = generateThumbnailPlaceholder({ vmid: 100, name: 'a', ostype: 'l26', status: 'running' });
    const b = generateThumbnailPlaceholder({ vmid: 104, name: 'a', ostype: 'l26', status: 'running' });
    expect(a).not.toBe(b);
  });
});
