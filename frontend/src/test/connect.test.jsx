import { afterEach, expect, test, vi } from 'vitest';
import { loginOptions, openSignup, readSignupEvent } from '@/lib/facebook';
import { apiUrl } from '@/lib/api';

const msg = (origin, data) => ({ origin, data: typeof data === 'string' ? data : JSON.stringify(data) });
const finish = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: '22', phone_number_id: '11' } };

afterEach(() => vi.useRealTimers());

test('signup messages are accepted only from facebook.com', () => {
  expect(readSignupEvent(msg('https://www.facebook.com', finish))).toEqual({ kind: 'finish', waba_id: '22', phone_number_id: '11' });
  for (const o of ['https://evilfacebook.com', 'http://www.facebook.com', 'https://facebook.com.evil.example', '', 'null']) expect(readSignupEvent(msg(o, finish))).toBeNull();
  expect(readSignupEvent(msg('https://www.facebook.com', 'not json'))).toBeNull();
});

test('coexistence finish carries only the account; cancel and error are recognised', () => {
  const fb = 'https://business.facebook.com';
  expect(readSignupEvent(msg(fb, { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: '22' } }))).toEqual({ kind: 'finish', waba_id: '22', phone_number_id: null });
  expect(readSignupEvent(msg(fb, { type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'PHONE' } }))).toMatchObject({ kind: 'cancel', step: 'PHONE' });
  expect(readSignupEvent(msg(fb, { type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', error_message: 'Nope' }))).toEqual({ kind: 'error', error: 'Nope' });
});

test('only coexistence asks for Business app onboarding', () => {
  expect(loginOptions('5', true)).toMatchObject({ config_id: '5', response_type: 'code', override_default_response_type: true, extras: { featureType: 'whatsapp_business_app_onboarding' } });
  expect(loginOptions('5', false).extras).not.toHaveProperty('featureType');
});

test('waits for ids that arrive just after the code', async () => {
  vi.useFakeTimers();
  const FB = { login: (cb) => cb({ authResponse: { code: 'abc' } }) };
  const p = openSignup(FB, '5', false);
  await vi.advanceTimersByTimeAsync(300);
  window.dispatchEvent(new MessageEvent('message', msg('https://www.facebook.com', finish)));
  await vi.advanceTimersByTimeAsync(200);
  expect(await p).toEqual({ code: 'abc', waba_id: '22', phone_number_id: '11' });
});

test('continues without ids (the server finds them), and rejects when the popup is closed', async () => {
  vi.useFakeTimers();
  const p = openSignup({ login: (cb) => cb({ authResponse: { code: 'abc' } }) }, '5', true);
  await vi.advanceTimersByTimeAsync(2500);
  expect(await p).toEqual({ code: 'abc', waba_id: null, phone_number_id: null });
  await expect(openSignup({ login: (cb) => cb({ status: 'unknown' }) }, '5', true)).rejects.toThrow(/did not finish/);
});

test('API links stay same-origin unless VITE_API_URL is set at build time', () => {
  expect(apiUrl('/media/1')).toBe('/api/media/1');
});
