import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';

const KEY = ['agent-config'];

export function useAgentConfig() {
  return useQuery({ queryKey: KEY, queryFn: async () => (await api.get('/agent/config')).data.config });
}

export function useVersions(enabled = true) {
  return useQuery({ queryKey: ['agent-versions'], enabled, queryFn: async () => (await api.get('/agent/config/versions')).data.versions });
}

export function useVersion(version) {
  return useQuery({
    queryKey: ['agent-version', version], enabled: !!version,
    queryFn: async () => (await api.get(`/agent/config/versions/${version}`)).data.version,
  });
}

function useConfigMutation(fn, successMsg) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (config) => {
      qc.setQueryData(KEY, config);
      qc.invalidateQueries({ queryKey: ['agent-versions'] });
      if (successMsg) toast.success(successMsg);
    },
    onError: (err) => {
      if (err?.response?.status === 409) {
        toast.error(errorMessage(err), { action: { label: 'Reload', onClick: () => qc.invalidateQueries({ queryKey: KEY }) } });
      } else toast.error(errorMessage(err));
    },
  });
}

export const useSaveConfig = () => useConfigMutation(async (body) => (await api.patch('/agent/config', body)).data.config, 'Saved');
export const useRestoreVersion = () => useConfigMutation(async (v) => (await api.post(`/agent/config/versions/${v}/restore`)).data.config, 'Version restored');
export const useSetApiKey = () => useConfigMutation(async (key) => (await api.put('/agent/config/api-key', { api_key: key })).data.config, 'API key saved');
export const useClearApiKey = () => useConfigMutation(async () => (await api.delete('/agent/config/api-key')).data.config, 'Saved key removed');
