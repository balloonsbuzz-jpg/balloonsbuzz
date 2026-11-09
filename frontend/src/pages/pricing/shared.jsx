import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';

/** PATCH/POST/PUT/DELETE helper that refreshes the given query keys and toasts. */
export function useSave(keys, { success = 'Saved' } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ method = 'patch', url, body }) => (await api[method](url, body)).data,
    onSuccess: () => {
      keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      if (success) toast.success(success);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export const toNum = (v) => (v === '' || v == null ? null : Number(v));
export const fromNum = (v) => (v == null ? '' : Number(v));

export function Hint({ children }) {
  return <p className="rounded-lg bg-accent/50 px-3 py-2 text-sm text-accent-foreground">{children}</p>;
}

export function Unconfirmed() {
  return <span className="rounded-full bg-accent px-2 py-px text-[11px] font-bold text-accent-foreground" title="Placeholder: confirm with the owner before going live">to confirm</span>;
}
