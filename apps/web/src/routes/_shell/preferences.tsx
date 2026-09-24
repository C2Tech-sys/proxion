import { createFileRoute } from '@tanstack/react-router';

import { PreferencesPage } from '@/pages/preferences/PreferencesPage';

export const Route = createFileRoute('/_shell/preferences')({
  component: PreferencesPage,
});
