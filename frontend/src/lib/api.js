import axios from 'axios';

// Same-origin API; cookies are httpOnly. The custom header satisfies the CSRF guard.
export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: { 'X-Requested-With': 'bb-web' },
  timeout: 20_000,
});

// On 401, try one silent refresh (rotating refresh token), then replay the request.
let refreshing = null;
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const { config, response } = error;
    const isAuthCall = config?.url?.startsWith('/auth/');
    if (response?.status === 401 && config && !config._retried && !isAuthCall) {
      config._retried = true;
      refreshing = refreshing || api.post('/auth/refresh').finally(() => { refreshing = null; });
      try {
        await refreshing;
        return api(config);
      } catch {
        window.dispatchEvent(new Event('bb:signed-out'));
      }
    }
    return Promise.reject(error);
  },
);

/** Human-readable message from an API error. */
export function errorMessage(err, fallback = 'Something went wrong') {
  const data = err?.response?.data;
  if (data?.details?.length) return data.details.map((d) => `${d.field ? `${d.field}: ` : ''}${d.message}`).join(' · ');
  return data?.error || err?.message || fallback;
}
