import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

/** A realistic agent token: install.sh generates 64 hex chars; the server requires >= 32. */
const AGENT_TOKEN = 'a'.repeat(64);

const BASE_ENV = { PVE_URL: 'https://pve.example.com:8006' };

describe('loadConfig', () => {
  it('fails fast with a readable message when PVE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/PVE_URL/);
  });

  it('fails fast when PVE_URL is not a valid URL', () => {
    expect(() => loadConfig({ PVE_URL: 'not-a-url' })).toThrow(/PVE_URL/);
  });

  it('requires SESSION_SECRET in production', () => {
    expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
  });

  it('auto-generates SESSION_SECRET (with a warning) outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig({ ...BASE_ENV, NODE_ENV: 'development' });
    expect(config.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not warn when generating SESSION_SECRET under NODE_ENV=test', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({ ...BASE_ENV, NODE_ENV: 'test' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('requires PVE_TOKEN_ID and PVE_TOKEN_SECRET together', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, NODE_ENV: 'test', PVE_TOKEN_ID: 'root@pam!proxion' }),
    ).toThrow(/PVE_TOKEN_SECRET/);
    expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: 'test', PVE_TOKEN_SECRET: 'secret' })).toThrow(
      /PVE_TOKEN_ID/,
    );
  });

  it('defaults PORT/HOST/NODE_ENV', () => {
    const config = loadConfig({ ...BASE_ENV, NODE_ENV: 'test' });
    expect(config.PORT).toBe(3080);
    expect(config.HOST).toBe('0.0.0.0');
  });

  describe('boolean env vars (PVE_TLS_INSECURE, PROXION_ALLOW_TOKEN_MODE)', () => {
    for (const key of ['PVE_TLS_INSECURE', 'PROXION_ALLOW_TOKEN_MODE'] as const) {
      it(`${key}: "false", "0", and "" all parse as false`, () => {
        expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'test', [key]: 'false' })[key]).toBe(false);
        expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'test', [key]: '0' })[key]).toBe(false);
        expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'test', [key]: '' })[key]).toBe(false);
      });

      it(`${key}: "true" and "1" both parse as true`, () => {
        expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'test', [key]: 'true' })[key]).toBe(true);
        expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'test', [key]: '1' })[key]).toBe(true);
      });

      it(`${key}: defaults to false when unset`, () => {
        expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'test' })[key]).toBe(false);
      });
    }
  });

  describe('PROXION_WEB_DIST', () => {
    it('is undefined by default', () => {
      expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'test' }).PROXION_WEB_DIST).toBeUndefined();
    });

    it('passes through the configured path unchanged', () => {
      expect(
        loadConfig({ ...BASE_ENV, NODE_ENV: 'test', PROXION_WEB_DIST: '/app/web/dist' })
          .PROXION_WEB_DIST,
      ).toBe('/app/web/dist');
    });
  });

  describe('PROXION_COOKIE_SECURE', () => {
    it('defaults to true in production', () => {
      expect(
        loadConfig({ ...BASE_ENV, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) })
          .PROXION_COOKIE_SECURE,
      ).toBe(true);
    });

    it('defaults to false outside production', () => {
      expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'development' }).PROXION_COOKIE_SECURE).toBe(
        false,
      );
      expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'test' }).PROXION_COOKIE_SECURE).toBe(false);
    });

    it('can be forced on outside production (e.g. behind a TLS-terminating reverse proxy)', () => {
      expect(
        loadConfig({ ...BASE_ENV, NODE_ENV: 'development', PROXION_COOKIE_SECURE: 'true' })
          .PROXION_COOKIE_SECURE,
      ).toBe(true);
    });

    it('can be forced off in production (e.g. plain HTTP on a private mesh)', () => {
      expect(
        loadConfig({
          ...BASE_ENV,
          NODE_ENV: 'production',
          SESSION_SECRET: 'x'.repeat(32),
          PROXION_COOKIE_SECURE: 'false',
        }).PROXION_COOKIE_SECURE,
      ).toBe(false);
    });
  });

  describe('PROXION_AGENTS / PROXION_AGENT_TOKEN / PROXION_AGENT_TIMEOUT_MS', () => {
    it('rejects a placeholder-length token (under 32 chars) when agents are configured', () => {
      expect(() =>
        loadConfig({
          ...BASE_ENV,
          NODE_ENV: 'test',
          PROXION_AGENTS: 'pve1=http://100.64.0.10:9420',
          PROXION_AGENT_TOKEN: 'PASTE_TOKEN_HERE',
        }),
      ).toThrow(/PROXION_AGENT_TOKEN: must be at least 32 characters/);
    });

    it('agents defaults to an empty map when PROXION_AGENTS is unset', () => {
      const config = loadConfig({ ...BASE_ENV, NODE_ENV: 'test' });
      expect(config.agents.size).toBe(0);
    });

    it('parses a single "node=url" pair', () => {
      const config = loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'test',
        PROXION_AGENTS: 'pve1=http://100.64.0.10:9420',
        PROXION_AGENT_TOKEN: AGENT_TOKEN,
      });
      expect(config.agents.get('pve1')).toBe('http://100.64.0.10:9420');
      expect(config.agents.size).toBe(1);
    });

    it('parses multiple comma-separated "node=url" pairs', () => {
      const config = loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'test',
        PROXION_AGENTS: 'c2dc2=http://100.64.0.24:9420,pve2=http://100.64.0.25:9420',
        PROXION_AGENT_TOKEN: AGENT_TOKEN,
      });
      expect(config.agents.get('c2dc2')).toBe('http://100.64.0.24:9420');
      expect(config.agents.get('pve2')).toBe('http://100.64.0.25:9420');
      expect(config.agents.size).toBe(2);
    });

    it('normalises a trailing slash off the URL', () => {
      const config = loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'test',
        PROXION_AGENTS: 'pve1=http://100.64.0.10:9420/',
        PROXION_AGENT_TOKEN: AGENT_TOKEN,
      });
      expect(config.agents.get('pve1')).toBe('http://100.64.0.10:9420');
    });

    it('accepts https URLs', () => {
      const config = loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'test',
        PROXION_AGENTS: 'pve1=https://100.64.0.10:9420',
        PROXION_AGENT_TOKEN: AGENT_TOKEN,
      });
      expect(config.agents.get('pve1')).toBe('https://100.64.0.10:9420');
    });

    it('fails fast on an entry missing "="', () => {
      expect(() =>
        loadConfig({
          ...BASE_ENV,
          NODE_ENV: 'test',
          PROXION_AGENTS: 'pve1-http://100.64.0.10:9420',
          PROXION_AGENT_TOKEN: AGENT_TOKEN,
        }),
      ).toThrow(/PROXION_AGENTS/);
    });

    it('fails fast on an entry with an empty node name', () => {
      expect(() =>
        loadConfig({
          ...BASE_ENV,
          NODE_ENV: 'test',
          PROXION_AGENTS: '=http://100.64.0.10:9420',
          PROXION_AGENT_TOKEN: AGENT_TOKEN,
        }),
      ).toThrow(/PROXION_AGENTS/);
    });

    it('fails fast on a non-URL value', () => {
      expect(() =>
        loadConfig({
          ...BASE_ENV,
          NODE_ENV: 'test',
          PROXION_AGENTS: 'pve1=not-a-url',
          PROXION_AGENT_TOKEN: AGENT_TOKEN,
        }),
      ).toThrow(/PROXION_AGENTS/);
    });

    it('fails fast on a non-http(s) URL scheme', () => {
      expect(() =>
        loadConfig({
          ...BASE_ENV,
          NODE_ENV: 'test',
          PROXION_AGENTS: 'pve1=ftp://100.64.0.10:9420',
          PROXION_AGENT_TOKEN: AGENT_TOKEN,
        }),
      ).toThrow(/PROXION_AGENTS/);
    });

    it('fails fast when PROXION_AGENTS is set but PROXION_AGENT_TOKEN is missing', () => {
      expect(() =>
        loadConfig({
          ...BASE_ENV,
          NODE_ENV: 'test',
          PROXION_AGENTS: 'pve1=http://100.64.0.10:9420',
        }),
      ).toThrow(/PROXION_AGENT_TOKEN/);
    });

    it('does not require PROXION_AGENT_TOKEN when PROXION_AGENTS is unset', () => {
      expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: 'test' })).not.toThrow();
    });

    it('PROXION_AGENT_TIMEOUT_MS defaults to 8000', () => {
      expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'test' }).PROXION_AGENT_TIMEOUT_MS).toBe(8000);
    });

    it('PROXION_AGENT_TIMEOUT_MS can be overridden', () => {
      expect(
        loadConfig({ ...BASE_ENV, NODE_ENV: 'test', PROXION_AGENT_TIMEOUT_MS: '3000' })
          .PROXION_AGENT_TIMEOUT_MS,
      ).toBe(3000);
    });
  });
});
