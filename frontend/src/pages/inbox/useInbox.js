import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';

export function useConversations(filter, search) {
  return useInfiniteQuery({
    queryKey: ['conversations', filter, search],
    queryFn: async ({ pageParam }) => (await api.get('/conversations', {
      params: { filter, ...(search ? { search } : {}), ...(pageParam ? { cursor: pageParam } : {}), limit: 30 },
    })).data,
    initialPageParam: null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export const useCounts = () => useQuery({
  queryKey: ['conv-counts'], queryFn: async () => (await api.get('/conversations/counts')).data, refetchInterval: 60_000,
});

export const useConversation = (id) => useQuery({
  queryKey: ['conversation', id], enabled: !!id, queryFn: async () => (await api.get(`/conversations/${id}`)).data.conversation,
});

export const useMessages = (id) => useQuery({
  queryKey: ['messages', id], enabled: !!id, queryFn: async () => (await api.get(`/conversations/${id}/messages`, { params: { limit: 100 } })).data.messages,
});

export const useCannedReplies = () => useQuery({
  queryKey: ['canned'], staleTime: 5 * 60_000, queryFn: async () => (await api.get('/conversations/meta/canned-replies')).data.canned_replies,
});

export const useTeam = () => useQuery({
  queryKey: ['team'], staleTime: 5 * 60_000, queryFn: async () => (await api.get('/conversations/meta/users')).data.users,
});

/** Generic conversation action (takeover/pause/resume/close/reopen/read/assign/send). */
export function useConvAction(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ path, body }) => (await api.post(`/conversations/${id}/${path}`, body || {})).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation', id] });
      qc.invalidateQueries({ queryKey: ['messages', id] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conv-counts'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}
