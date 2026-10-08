import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getNotifySettings,
  getNotifyStatus,
  muteNotifications,
  putNotifySettings,
  sendTestNotification,
  type MuteSpan,
  type NotifySettingsPutBody,
  type NotifySettingsView,
  type NotifyTestResults,
} from '@/api/notify';
import { useAuthMe } from '@/api/hooks';
import { errorMessage } from '@/api/errors';

export const NOTIFY_STATUS_QUERY_KEY = ['notify-status'] as const;
export const NOTIFY_SETTINGS_QUERY_KEY = ['notify-settings'] as const;

/** Which notification channels the server has configured -- disabled until a signed-in identity
 *  is known, same rationale as `usePrefs()`. */
export function useNotifyStatus() {
  const { data: auth } = useAuthMe();
  return useQuery({
    queryKey: NOTIFY_STATUS_QUERY_KEY,
    queryFn: () => getNotifyStatus(),
    enabled: Boolean(auth),
    staleTime: 60_000,
  });
}

function summariseResults(results: NotifyTestResults): { ok: boolean; text: string } {
  const entries = Object.entries(results);
  const failed = entries.filter(([, result]) => result !== 'ok');
  if (failed.length === 0) {
    return { ok: true, text: `Test notification sent (${entries.map(([name]) => name).join(', ')})` };
  }
  const failedNames = failed.map(([name, reason]) => `${name}: ${reason}`).join('; ');
  return { ok: false, text: `Test notification failed -- ${failedNames}` };
}

/** `POST /api/notify/test` -- toasts success/failure per channel result (a channel can fail
 *  independently of the others, so a single "ok"/"error" toast isn't enough). */
export function useSendTestNotification() {
  return useMutation({
    mutationFn: () => sendTestNotification(),
    onSuccess: (results) => {
      const { ok, text } = summariseResults(results);
      if (ok) toast.success(text);
      else toast.error(text);
    },
    onError: (error: unknown) => {
      toast.error(`Could not send test notification: ${errorMessage(error)}`);
    },
  });
}

// --- Runtime-editable settings (T64) ------------------------------------------------------------

/** The masked effective settings (`GET /api/notify/settings`) -- any signed-in identity can read them. */
export function useNotifySettings() {
  const { data: auth } = useAuthMe();
  return useQuery({
    queryKey: NOTIFY_SETTINGS_QUERY_KEY,
    queryFn: () => getNotifySettings(),
    enabled: Boolean(auth),
    staleTime: 30_000,
  });
}

/** What a settings write changes besides the settings themselves: the T43 status (which channels
 *  exist) behind the Preferences "Channels" row and the "Send test" button. */
function useApplySettings() {
  const queryClient = useQueryClient();
  return (settings: NotifySettingsView) => {
    queryClient.setQueryData(NOTIFY_SETTINGS_QUERY_KEY, settings);
    void queryClient.invalidateQueries({ queryKey: NOTIFY_STATUS_QUERY_KEY });
  };
}

/** `PUT /api/notify/settings`. Success toasts; an error is NOT toasted -- the form shows the
 *  server's message inline and stays dirty so it can be corrected (same convention as `useUpsertNic`). */
export function useSaveNotifySettings() {
  const apply = useApplySettings();
  return useMutation({
    mutationFn: (body: NotifySettingsPutBody) => putNotifySettings(body),
    onSuccess: (settings) => {
      apply(settings);
      toast.success('Notification settings saved');
    },
  });
}

const MUTE_LABEL: Record<MuteSpan, string> = { '1h': '1 hour', '8h': '8 hours', '24h': '24 hours', '7d': '7 days' };

/** `POST /api/notify/mute` -- the Snooze / Unmute buttons. */
export function useMuteNotifications() {
  const apply = useApplySettings();
  return useMutation({
    mutationFn: (span: MuteSpan | null) => muteNotifications(span),
    onSuccess: (settings, span) => {
      apply(settings);
      toast.success(span === null ? 'Notifications unmuted' : `Notifications muted for ${MUTE_LABEL[span]}`);
    },
    onError: (error: unknown) => {
      toast.error(`Could not change the mute: ${errorMessage(error)}`);
    },
  });
}
