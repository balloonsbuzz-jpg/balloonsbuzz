// Meta's Embedded Signup popup (Facebook JavaScript SDK).
// Needs https and this site's domain listed in the Meta app (Facebook Login for Business →
// Settings → Allowed domains for the JavaScript SDK + Valid OAuth redirect URIs).

let loading = null;

/** Loads and initialises the SDK once. */
export function loadFacebookSdk({ app_id: appId, sdk_version: version }) {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, cookie: true, xfbml: false, autoLogAppEvents: false, version });
      resolve(window.FB);
    };
    const s = document.createElement('script');
    s.id = 'facebook-jssdk';
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.onerror = () => { loading = null; s.remove(); reject(new Error('Could not load Facebook. Turn off ad/tracker blockers for this page and reload.')); };
    document.head.appendChild(s);
  });
  return loading;
}

const isFacebook = (origin) => {
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === 'https:' && (hostname === 'facebook.com' || hostname.endsWith('.facebook.com'));
  } catch { return false; }
};

/** The popup's own messages: which account/number was chosen, or why it stopped. Null when not one. */
export function readSignupEvent(event) {
  if (!isFacebook(event.origin)) return null;
  try {
    const d = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (d?.type !== 'WA_EMBEDDED_SIGNUP') return null;
    if (String(d.event).startsWith('FINISH')) return { kind: 'finish', waba_id: d.data?.waba_id || null, phone_number_id: d.data?.phone_number_id || null };
    if (d.event === 'CANCEL') return { kind: 'cancel', step: d.data?.current_step || null, error: d.data?.error_message || null };
    if (d.event === 'ERROR') return { kind: 'error', error: d.error_message || d.data?.error_message || 'Facebook reported an error' };
  } catch { /* other messages from Facebook are not JSON */ }
  return null;
}

/** Options for FB.login. `coexistence` keeps the number in the WhatsApp Business app as well. */
export function loginOptions(configId, coexistence) {
  return {
    config_id: configId,
    response_type: 'code',
    override_default_response_type: true,
    extras: {
      setup: {},
      version: 'v4',
      sessionInfoVersion: '3',
      ...(coexistence ? { featureType: 'whatsapp_business_app_onboarding' } : {}),
    },
  };
}

/**
 * Opens the popup; call it directly from a click or the browser blocks it.
 * @returns {Promise<{code, waba_id, phone_number_id}>} rejects when cancelled
 */
export function openSignup(FB, configId, coexistence) {
  return new Promise((resolve, reject) => {
    let info = null;
    const onMessage = (e) => { info = readSignupEvent(e) || info; };
    window.addEventListener('message', onMessage);
    const done = (fn) => { window.removeEventListener('message', onMessage); fn(); };
    const cancelled = () => new Error(info?.error || (info?.kind === 'cancel' ? 'You closed the Facebook window before finishing.' : 'Facebook did not finish the setup. Please try again and complete every step.'));

    // Must be a plain function: the SDK refuses async callbacks.
    FB.login((response) => {
      const code = response?.authResponse?.code;
      if (!code) { done(() => reject(cancelled())); return; }
      // The message with the ids can arrive just after the code. The server can also find them itself.
      const started = Date.now();
      const wait = () => {
        if (info?.kind === 'finish' || Date.now() - started > 2000) {
          const ids = info?.kind === 'finish' ? info : {};
          done(() => resolve({ code, waba_id: ids.waba_id || null, phone_number_id: ids.phone_number_id || null }));
        } else setTimeout(wait, 100);
      };
      wait();
    }, loginOptions(configId, coexistence));
  });
}
