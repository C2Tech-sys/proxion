import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getNotifyStatus, sendTestNotification, type NotifyTestResults } from '@/api/notify';
import { useAuthMe } from '@/api/hooks';
import { errorMessage } from '@/api/errors';

export const NOTIFY_STATUS_QUERY_KEY = ['notify-status'] as const;

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
