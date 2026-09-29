import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestActionError, uploadToStorage } from '@/api/actions';

/**
 * `uploadToStorage`'s real `XMLHttpRequest` wiring (T34) -- deliberately does NOT mock `@/api/actions`
 * itself (unlike `storage-actions.render.test.tsx`, which mocks it entirely to test the dialogs in
 * isolation): this file exercises the actual implementation, with a fake `XMLHttpRequest` standing
 * in for the network so `onload`/`onerror`/`onabort` can be triggered deterministically.
 *
 * `apps/web/.env.test` sets `VITE_USE_FIXTURES=1` for the whole test suite (so `USE_FIXTURES` is
 * `true` by default here) -- overridden the same way `storage-actions.render.test.tsx` does, so
 * `uploadToStorage`'s real (non-fixture) branch actually runs.
 */
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

class FakeXhrUpload {
  onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null = null;
}

class FakeXhr {
  static instances: FakeXhr[] = [];

  method = '';
  url = '';
  timeout: number | undefined;
  status = 0;
  statusText = '';
  responseText = '';
  upload = new FakeXhrUpload();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  sentBody: unknown;
  aborted = false;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: unknown) {
    this.sentBody = body;
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

describe('uploadToStorage (real XHR wiring)', () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the first 64 KiB before opening the XHR, and resolves on a 202', async () => {
    const file = new File(['x'.repeat(1024)], 'debian.iso', { type: 'application/octet-stream' });

    const promise = uploadToStorage('pve1', 'local', { content: 'iso', filename: 'debian.iso', file });

    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0]!;
    expect(xhr.timeout).toBe(0);
    expect(xhr.url).toContain('/api/actions/storage/pve1/local/upload?');

    xhr.status = 202;
    xhr.responseText = JSON.stringify({ upid: 'UPID:test:1::::imgcopy::root@pam:' });
    xhr.onload?.();

    await expect(promise).resolves.toEqual({ upid: 'UPID:test:1::::imgcopy::root@pam:' });
  });

  it('sends the file as a `filename` form field (not `file`, and no separate text `filename` field) -- pveproxy\'s own multipart parser requires exactly this field name (T35)', async () => {
    const file = new File(['x'.repeat(1024)], 'debian.iso', { type: 'application/octet-stream' });

    void uploadToStorage('pve1', 'local', { content: 'iso', filename: 'debian.iso', file });

    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const sent = FakeXhr.instances[0]!.sentBody as FormData;
    expect(sent).toBeInstanceOf(FormData);

    const fieldNames = Array.from(sent.keys());
    expect(fieldNames).toEqual(['content', 'filename']);
    expect(sent.get('content')).toBe('iso');

    const filePart = sent.get('filename');
    expect(filePart).toBeInstanceOf(File);
    expect((filePart as File).name).toBe('debian.iso');
  });

  it('a File whose bytes cannot be read fails immediately without ever opening an XHR', async () => {
    // A duck-typed stand-in for `File` whose `slice().arrayBuffer()` rejects -- simulating a
    // cloud-sync placeholder that was never fully downloaded, or a file that changed/disappeared
    // on disk after being selected (Chrome's own `net::ERR_UPLOAD_FILE_CHANGED`).
    const unreadableFile = {
      name: 'bookworm.iso',
      size: 3_000_000_000,
      slice: () => ({
        arrayBuffer: () => Promise.reject(new Error('could not read file')),
      }),
    } as unknown as File;

    const promise = uploadToStorage('pve1', 'local', { content: 'iso', filename: 'bookworm.iso', file: unreadableFile });

    await expect(promise).rejects.toMatchObject({
      status: 0,
      message:
        'The browser could not read this file. If it lives in a cloud-synced folder, make sure it is fully downloaded, then try again.',
    });
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('rejects a promise of the right type (GuestActionError) on an unreadable file', async () => {
    const unreadableFile = {
      name: 'bookworm.iso',
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error('x')) }),
    } as unknown as File;

    await expect(uploadToStorage('pve1', 'local', { content: 'iso', filename: 'bookworm.iso', file: unreadableFile })).rejects.toBeInstanceOf(
      GuestActionError,
    );
  });

  it('a status-0 xhr.onerror no longer blames Proxmox -- it never received the request', async () => {
    const file = new File(['x'], 'debian.iso', { type: 'application/octet-stream' });

    const promise = uploadToStorage('pve1', 'local', { content: 'iso', filename: 'debian.iso', file });

    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    FakeXhr.instances[0]!.onerror?.();

    await expect(promise).rejects.toMatchObject({
      status: 0,
      message:
        'The upload never reached Proxion. Check that the file is readable and that any proxy in front of Proxion allows large uploads.',
    });
  });

  it('still honours cancellation via AbortSignal (existing abort handling preserved)', async () => {
    const file = new File(['x'], 'debian.iso', { type: 'application/octet-stream' });
    const controller = new AbortController();

    const promise = uploadToStorage('pve1', 'local', {
      content: 'iso',
      filename: 'debian.iso',
      file,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ status: 0, message: 'Upload cancelled' });
    expect(FakeXhr.instances[0]!.aborted).toBe(true);
  });
});
