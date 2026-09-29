import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { createQueryClient } from '@/api/queryClient';
import { TASKS_QUERY_KEY } from '@/api/liveState';
import { GuestActionError } from '@/api/actions';
import type { PveTask } from '@/api/types';
import {
  useUploadStore,
  findActiveUpload,
  selectUploadsFor,
  UPLOAD_AUTO_REMOVE_MS,
  __resetUploadStoreForTests,
} from '@/store/uploadStore';

/**
 * `useUploadStore` (T39): the app-wide upload tracker `UploadDialog`/`UploadsIndicator` both read.
 * `uploadToStorage` is mocked so every test controls exactly when it resolves/rejects/reports
 * progress -- same mocking shape `storage-actions.render.test.tsx` uses for its own dialog tests,
 * just exercised directly against the store instead of through a rendered component. `USE_FIXTURES`
 * is forced `false` so `start()` takes its real (non-fixture) branch, which is what actually
 * exercises `watchUploadTask`'s subscription to the live `['tasks']` cache -- the fixture branch's
 * "finish immediately" path is a single `if` with nothing store-specific left to cover once that's
 * true.
 */
const mockUploadToStorage = vi.fn();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return { ...actual, uploadToStorage: (...args: unknown[]) => mockUploadToStorage(...args) };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function makeFile(size = 100): File {
  return new File(['x'.repeat(size)], 'debian-12.iso', { type: 'application/octet-stream' });
}

const START_VARS = { node: 'pve1', storage: 'local', content: 'iso' as const, filename: 'debian-12.iso' };

describe('useUploadStore', () => {
  beforeEach(() => {
    __resetUploadStoreForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    __resetUploadStoreForTests();
    vi.useRealTimers();
  });

  it('tracks progress reported by onProgress, and reattach helpers see it while uploading', () => {
    let onProgress: ((sent: number, total: number) => void) | undefined;
    mockUploadToStorage.mockImplementation((_node, _storage, options) => {
      onProgress = options.onProgress;
      return new Promise(() => {}); // never settles for this test
    });

    const queryClient = createQueryClient();
    const id = useUploadStore.getState().start({ ...START_VARS, file: makeFile(200) }, queryClient);

    let entry = useUploadStore.getState().uploads[id]!;
    expect(entry.status).toBe('uploading');
    expect(entry.total).toBe(200);
    expect(entry.sent).toBe(0);

    onProgress?.(80, 200);
    entry = useUploadStore.getState().uploads[id]!;
    expect(entry.sent).toBe(80);

    expect(findActiveUpload(useUploadStore.getState().uploads, 'pve1', 'local')?.id).toBe(id);
    expect(selectUploadsFor(useUploadStore.getState().uploads, 'pve1', 'local')).toHaveLength(1);
    expect(findActiveUpload(useUploadStore.getState().uploads, 'pve1', 'other')).toBeUndefined();
  });

  it('202 -> processing -> a finished OK task -> done, invalidates storage-content, and toasts both steps', async () => {
    let resolveUpload: ((v: { upid: string }) => void) | undefined;
    mockUploadToStorage.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));

    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const id = useUploadStore.getState().start({ ...START_VARS, file: makeFile() }, queryClient);

    resolveUpload?.({ upid: 'UPID:test:1::::imgcopy::root@pam:' });
    await vi.waitFor(() => expect(useUploadStore.getState().uploads[id]?.status).toBe('processing'));
    expect(toast.success).toHaveBeenCalledWith('Upload started: debian-12.iso');
    expect(useUploadStore.getState().uploads[id]?.upid).toBe('UPID:test:1::::imgcopy::root@pam:');

    const task: PveTask = {
      upid: 'UPID:test:1::::imgcopy::root@pam:',
      node: 'pve1',
      pid: 1,
      pstart: 1,
      starttime: 1,
      type: 'imgcopy',
      id: '1',
      user: 'root@pam',
      endtime: 2,
      status: 'OK',
    };
    queryClient.setQueryData(TASKS_QUERY_KEY, [task]);

    await vi.waitFor(() => expect(useUploadStore.getState().uploads[id]?.status).toBe('done'));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['storage-content', 'pve1', 'local'] });
    expect(toast.success).toHaveBeenCalledWith('debian-12.iso is ready');
  });

  it('a task that finishes with a non-OK status moves the entry to error and toasts it', async () => {
    let resolveUpload: ((v: { upid: string }) => void) | undefined;
    mockUploadToStorage.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));

    const queryClient = createQueryClient();
    const id = useUploadStore.getState().start({ ...START_VARS, file: makeFile() }, queryClient);
    resolveUpload?.({ upid: 'UPID:test:2::::imgcopy::root@pam:' });
    await vi.waitFor(() => expect(useUploadStore.getState().uploads[id]?.status).toBe('processing'));

    queryClient.setQueryData(TASKS_QUERY_KEY, [
      {
        upid: 'UPID:test:2::::imgcopy::root@pam:',
        node: 'pve1',
        pid: 1,
        pstart: 1,
        starttime: 1,
        type: 'imgcopy',
        id: '2',
        user: 'root@pam',
        endtime: 2,
        status: 'image is corrupt',
      } satisfies PveTask,
    ]);

    await vi.waitFor(() => expect(useUploadStore.getState().uploads[id]?.status).toBe('error'));
    expect(useUploadStore.getState().uploads[id]?.error).toContain('image is corrupt');
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('image is corrupt'));
  });

  it('a rejected upload moves straight to error with the rejection message and toasts it', async () => {
    mockUploadToStorage.mockRejectedValue(new GuestActionError(500, 'Datastore is full'));

    const id = useUploadStore.getState().start({ ...START_VARS, file: makeFile() }, createQueryClient());

    await vi.waitFor(() => expect(useUploadStore.getState().uploads[id]?.status).toBe('error'));
    expect(useUploadStore.getState().uploads[id]?.error).toBe('Datastore is full');
    expect(toast.error).toHaveBeenCalledWith('Datastore is full');
  });

  it('cancel aborts the signal passed to uploadToStorage, which settles the entry as error', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockUploadToStorage.mockImplementation(
      (_node, _storage, options) =>
        new Promise((_resolve, reject) => {
          capturedSignal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new GuestActionError(0, 'Upload cancelled')));
        }),
    );

    const id = useUploadStore.getState().start({ ...START_VARS, file: makeFile() }, createQueryClient());
    expect(capturedSignal?.aborted).toBe(false);

    useUploadStore.getState().cancel(id);
    expect(capturedSignal?.aborted).toBe(true);

    await vi.waitFor(() => expect(useUploadStore.getState().uploads[id]?.status).toBe('error'));
    expect(useUploadStore.getState().uploads[id]?.error).toBe('Upload cancelled');
    expect(toast.error).toHaveBeenCalledWith('Upload cancelled');
  });

  it('cancel on an id that has already settled (or never existed) is a no-op', () => {
    expect(() => useUploadStore.getState().cancel('does-not-exist')).not.toThrow();
  });

  it('a settled entry is auto-removed after UPLOAD_AUTO_REMOVE_MS unless dismissed first', async () => {
    vi.useFakeTimers();
    mockUploadToStorage.mockRejectedValue(new GuestActionError(500, 'boom'));

    const id = useUploadStore.getState().start({ ...START_VARS, file: makeFile() }, createQueryClient());

    // Flushes the rejected promise's `.then`/`.catch` microtask chain -- fake timers only fake
    // `setTimeout`/`Date`, never Promise microtasks, so this settles without advancing any clock.
    await Promise.resolve();
    await Promise.resolve();
    expect(useUploadStore.getState().uploads[id]?.status).toBe('error');

    vi.advanceTimersByTime(UPLOAD_AUTO_REMOVE_MS - 1);
    expect(useUploadStore.getState().uploads[id]).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(useUploadStore.getState().uploads[id]).toBeUndefined();
  });

  it('dismiss removes an entry immediately and cancels its pending auto-removal', async () => {
    mockUploadToStorage.mockRejectedValue(new GuestActionError(500, 'boom'));
    const id = useUploadStore.getState().start({ ...START_VARS, file: makeFile() }, createQueryClient());

    await vi.waitFor(() => expect(useUploadStore.getState().uploads[id]?.status).toBe('error'));
    useUploadStore.getState().dismiss(id);
    expect(useUploadStore.getState().uploads[id]).toBeUndefined();
  });
});
