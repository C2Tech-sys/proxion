import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { StorageActions } from '@/components/storage/StorageActions';
import { StorageContentBrowser } from '@/components/storage/StorageContentBrowser';
import { Toaster } from '@/components/ui/sonner';
import { createQueryClient } from '@/api/queryClient';
import { DEFAULT_STORAGE_BROWSER_STATE } from '@/lib/storageList';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';
import type { StorageContentItem } from '@/api/types';

/**
 * `StorageActions`/`UploadDialog`/`DownloadUrlDialog` gating and submit flow (T32), same mocking
 * shape `node-actions.render.test.tsx` uses for its own quick-action gating: `useAuthMe`/
 * `useStoragePermissions` control the session/privilege gate, and `uploadToStorage`/
 * `downloadUrlToStorage`/`queryUrlMetadata` are mocked so a submit's exact request is asserted
 * directly without a real network layer. The fixture-mode describe block below instead calls the
 * fixture functions directly, same convention `migrate-guest.render.test.tsx`'s own
 * `fixture-mode migrate` block uses.
 */
const mockUseAuthMe = vi.fn();
const mockUseStoragePermissions = vi.fn();
const mockUseStorageContent = vi.fn();
const mockUseClusterResources = vi.fn();
const mockUploadToStorage = vi.fn();
const mockDownloadUrlToStorage = vi.fn();
const mockQueryUrlMetadata = vi.fn();
const mockDeleteStorageContent = vi.fn();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return {
    ...actual,
    useAuthMe: () => mockUseAuthMe(),
    useStorageContent: (...args: unknown[]) => mockUseStorageContent(...args),
    useClusterResources: () => mockUseClusterResources(),
  };
});

vi.mock('@/api/actionHooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/actionHooks')>('@/api/actionHooks');
  return { ...actual, useStoragePermissions: (storage: string) => mockUseStoragePermissions(storage) };
});

vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return {
    ...actual,
    uploadToStorage: (...args: unknown[]) => mockUploadToStorage(...args),
    downloadUrlToStorage: (...args: unknown[]) => mockDownloadUrlToStorage(...args),
    queryUrlMetadata: (...args: unknown[]) => mockQueryUrlMetadata(...args),
    deleteStorageContent: (...args: unknown[]) => mockDeleteStorageContent(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(can: boolean) {
  const value: GuestPermissions = { can: () => can };
  return { data: value };
}

function renderActions(contentTypes: string[] = ['iso', 'vztmpl', 'backup']) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <StorageActions node="pve1" storage="local" contentTypes={contentTypes} />
      <Toaster />
    </QueryClientProvider>,
  );
}

/** Sets a native file input's `files` -- jsdom's `HTMLInputElement.prototype.files` has no public
 * setter, so this defines it directly on the element instance, the standard workaround absent
 * `@testing-library/user-event` (not a dependency here). */
function selectFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

function renderBrowser(items: StorageContentItem[]) {
  mockUseStorageContent.mockReturnValue({ data: items, isLoading: false, isError: false, error: undefined });
  mockUseClusterResources.mockReturnValue({ data: [] });
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <StorageContentBrowser
        node="pve1"
        storage="local"
        mode="page"
        state={DEFAULT_STORAGE_BROWSER_STATE}
        onStateChange={() => {}}
      />
      <Toaster />
    </QueryClientProvider>,
  );
}

function openRowMenu(name: string) {
  const trigger = screen.getByRole('button', { name: `Actions for ${name}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
  return trigger;
}

describe('StorageActions gating', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('token mode: both buttons are disabled with the read-only tooltip text', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUseStoragePermissions.mockReturnValue(permissionsData(true));

    renderActions();

    const upload = await screen.findByRole('button', { name: /Upload/ });
    const download = await screen.findByRole('button', { name: /Download from URL/ });
    expect(upload).toBeDisabled();
    expect(upload).toHaveAttribute('title', 'Read-only: signed in with a service token');
    expect(download).toBeDisabled();
    expect(download).toHaveAttribute('title', 'Read-only: signed in with a service token');
  });

  it("missing Datastore.AllocateTemplate: both buttons are disabled with the missing-privilege tooltip text", async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseStoragePermissions.mockReturnValue(permissionsData(false));

    renderActions();

    const upload = await screen.findByRole('button', { name: /Upload/ });
    expect(upload).toBeDisabled();
    expect(upload).toHaveAttribute('title', "You don't have Datastore.AllocateTemplate on this storage");
  });

  it('a storage whose content is only images,rootdir shows neither button', () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseStoragePermissions.mockReturnValue(permissionsData(true));

    renderActions(['images', 'rootdir']);

    expect(screen.queryByRole('button', { name: /Upload/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download from URL/ })).not.toBeInTheDocument();
  });
});

describe('UploadDialog', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens on Upload, fills the filename from the chosen file, validates it, and submits with content/filename/file', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseStoragePermissions.mockReturnValue(permissionsData(true));
    let resolveUpload: ((value: { upid: string }) => void) | undefined;
    mockUploadToStorage.mockImplementation((_node: string, _storage: string, options: { onProgress?: (s: number, t: number) => void }) => {
      options.onProgress?.(50, 100);
      return new Promise((resolve) => {
        resolveUpload = resolve;
      });
    });

    renderActions();
    fireEvent.click(await screen.findByRole('button', { name: /^Upload$/ }));

    expect(await screen.findByText('Upload to local')).toBeInTheDocument();

    const fileInput = screen.getByLabelText('File') as HTMLInputElement;
    const file = new File(['x'.repeat(100)], 'debian-12.iso', { type: 'application/octet-stream' });
    selectFile(fileInput, file);

    const filenameInput = screen.getByLabelText('Filename') as HTMLInputElement;
    await waitFor(() => expect(filenameInput.value).toBe('debian-12.iso'));

    // An invalid filename (a space is not allowed) shows the inline error and disables submit.
    fireEvent.change(filenameInput, { target: { value: 'bad name.iso' } });
    expect(screen.getByText(/Filename must start with a letter or digit/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();

    fireEvent.change(filenameInput, { target: { value: 'debian-12.iso' } });
    expect(screen.getByRole('button', { name: 'Upload' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));

    await waitFor(() =>
      expect(mockUploadToStorage).toHaveBeenCalledWith(
        'pve1',
        'local',
        expect.objectContaining({ content: 'iso', filename: 'debian-12.iso', file }),
      ),
    );

    // The progress bar reflects the mocked function's own `onProgress` call.
    await waitFor(() => expect(screen.getByText(/50%/)).toBeInTheDocument());

    resolveUpload?.({ upid: 'UPID:test:00000001::::imgcopy::root@pam:' });
    await waitFor(() => expect(screen.queryByText('Upload to local')).not.toBeInTheDocument());
  });
});

describe('DownloadUrlDialog', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Query URL fills the filename from mocked metadata; submit calls downloadUrlToStorage with the exact body', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseStoragePermissions.mockReturnValue(permissionsData(true));
    mockQueryUrlMetadata.mockResolvedValue({ filename: 'debian-12.iso', size: 700_000_000 });
    mockDownloadUrlToStorage.mockResolvedValue({ upid: 'UPID:test:00000001::::download::root@pam:' });

    renderActions();
    fireEvent.click(await screen.findByRole('button', { name: /Download from URL/ }));
    expect(await screen.findByText('Download from URL to local')).toBeInTheDocument();

    const urlInput = screen.getByLabelText('URL');
    fireEvent.change(urlInput, { target: { value: 'https://example.com/debian-12.iso' } });

    fireEvent.click(screen.getByRole('button', { name: 'Query URL' }));
    await waitFor(() => expect(mockQueryUrlMetadata).toHaveBeenCalledWith('pve1', 'https://example.com/debian-12.iso', true));

    const filenameInput = screen.getByLabelText('Filename') as HTMLInputElement;
    await waitFor(() => expect(filenameInput.value).toBe('debian-12.iso'));

    fireEvent.click(screen.getByRole('button', { name: 'Start download' }));

    await waitFor(() =>
      expect(mockDownloadUrlToStorage).toHaveBeenCalledWith('pve1', 'local', {
        url: 'https://example.com/debian-12.iso',
        content: 'iso',
        filename: 'debian-12.iso',
        verifyCertificates: true,
      }),
    );
  });
});

const ISO_ITEM: StorageContentItem = { volid: 'local:iso/x.iso', content: 'iso', size: 123, ctime: 1_700_000_000 };
const UNPROTECTED_BACKUP: StorageContentItem = {
  volid: 'local:backup/vzdump-100.vma.zst',
  content: 'backup',
  size: 456,
  vmid: 100,
  ctime: 1_700_000_100,
};
const PROTECTED_BACKUP = {
  volid: 'local:backup/vzdump-200.vma.zst',
  content: 'backup',
  size: 789,
  vmid: 200,
  ctime: 1_700_000_200,
  protected: true,
} as StorageContentItem;

describe('StorageContentBrowser row delete (T32 addendum)', () => {
  beforeEach(() => {
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = () => {};
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = () => {};
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('row menu Delete… opens the confirmation dialog; confirm calls deleteStorageContent with vmid: undefined for a plain volume', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseStoragePermissions.mockReturnValue(permissionsData(true));
    mockDeleteStorageContent.mockResolvedValue({ upid: 'UPID:test:00000001::::imgdel::root@pam:' });

    renderBrowser([ISO_ITEM]);

    openRowMenu('iso/x.iso');
    fireEvent.click(await screen.findByText('Delete…'));

    expect(await screen.findByText('Delete iso/x.iso?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete volume' }));

    await waitFor(() =>
      expect(mockDeleteStorageContent).toHaveBeenCalledWith('pve1', 'local', 'local:iso/x.iso', { vmid: undefined }),
    );
  });

  it('a backup row passes its owner vmid', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseStoragePermissions.mockReturnValue(permissionsData(true));
    mockDeleteStorageContent.mockResolvedValue({ upid: 'UPID:test:00000001::::imgdel::root@pam:' });

    renderBrowser([UNPROTECTED_BACKUP]);

    openRowMenu('backup/vzdump-100.vma.zst');
    fireEvent.click(await screen.findByText('Delete…'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete volume' }));

    await waitFor(() =>
      expect(mockDeleteStorageContent).toHaveBeenCalledWith(
        'pve1',
        'local',
        'local:backup/vzdump-100.vma.zst',
        { vmid: 100 },
      ),
    );
  });

  it('a protected backup row is disabled with "Protected backup"', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseStoragePermissions.mockReturnValue(permissionsData(true));

    renderBrowser([PROTECTED_BACKUP]);

    const trigger = screen.getByRole('button', { name: 'Actions for backup/vzdump-200.vma.zst' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', 'Protected backup');
  });

  it('token mode: the row action is disabled with the read-only tooltip text', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUseStoragePermissions.mockReturnValue(permissionsData(true));

    renderBrowser([ISO_ITEM]);

    const trigger = screen.getByRole('button', { name: 'Actions for iso/x.iso' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', 'Read-only: signed in with a service token');
  });
});

describe('fixture-mode storage actions', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('fixtureDownloadUrlToStorage adds the new volid to the fixture storage content', async () => {
    const { fixtureDownloadUrlToStorage } = await import('@/api/actionsFixture');
    const { fixtureClient } = await import('@/api/fixtures');

    const before = await fixtureClient.getStorageContent('pve1', 'local');
    const volid = 'local:iso/fixture-test.iso';
    expect(before.some((item) => item.volid === volid)).toBe(false);

    await fixtureDownloadUrlToStorage('pve1', 'local', {
      url: 'https://example.com/fixture-test.iso',
      content: 'iso',
      filename: 'fixture-test.iso',
    });

    const after = await fixtureClient.getStorageContent('pve1', 'local');
    expect(after.some((item) => item.volid === volid)).toBe(true);
  });

  it('fixtureDeleteStorageContent removes the volid from the fixture storage content', async () => {
    const { fixtureDownloadUrlToStorage, fixtureDeleteStorageContent } = await import('@/api/actionsFixture');
    const { fixtureClient } = await import('@/api/fixtures');

    const volid = 'local:iso/fixture-delete-test.iso';
    await fixtureDownloadUrlToStorage('pve1', 'local', {
      url: 'https://example.com/fixture-delete-test.iso',
      content: 'iso',
      filename: 'fixture-delete-test.iso',
    });
    expect((await fixtureClient.getStorageContent('pve1', 'local')).some((item) => item.volid === volid)).toBe(true);

    await fixtureDeleteStorageContent('pve1', 'local', volid);

    expect((await fixtureClient.getStorageContent('pve1', 'local')).some((item) => item.volid === volid)).toBe(false);
  });
});
