import axios from 'axios';

// Empty = same origin (dev proxy, nginx). On Vercel the API has its own host: vite.config.js sets it.
const API_ORIGIN = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

/** Full address of an API path, for things axios doesn't load: photos, downloads, live updates. */
export const apiUrl = (path) => `${API_ORIGIN}/api${path}`;

// Cookies are httpOnly. The custom header satisfies the CSRF guard.
export const api = axios.create({
  baseURL: apiUrl(''),
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
    const isAuthCall = config?.url?.startsWith('/auth/') && config.url !== '/auth/me';
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
