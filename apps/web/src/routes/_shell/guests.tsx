import { createFileRoute } from '@tanstack/react-router';

import { GuestsPage } from '@/pages/guests/GuestsPage';
import { parseGuestsSearch, type GuestsSearch } from '@/pages/guests/guestList';

export const Route = createFileRoute('/_shell/guests')({
  // Every field is optional and omitted from the URL at its default (see `toGuestsSearch`), so
  // the default view is a bare `/guests` -- only a search, filter or sort actually applied shows
  // up as a query param.
  validateSearch: (search: Record<string, unknown>): GuestsSearch => parseGuestsSearch(search),
  component: GuestsPage,
});
