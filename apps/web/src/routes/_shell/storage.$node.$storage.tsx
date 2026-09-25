import { createFileRoute } from '@tanstack/react-router';

import { StoragePage } from '@/pages/storage/StoragePage';
import { parseStorageSearch, type StorageSearch } from '@/lib/storageList';

export const Route = createFileRoute('/_shell/storage/$node/$storage')({
  // Every field is optional and omitted from the URL at its default (see `toStorageSearch`), so
  // the default view is a bare `/storage/$node/$storage` -- only a filter/search/sort actually
  // applied shows up as a query param (same convention as `/guests`).
  validateSearch: (search: Record<string, unknown>): StorageSearch => parseStorageSearch(search),
  component: StoragePage,
});
