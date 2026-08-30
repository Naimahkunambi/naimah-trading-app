import test from 'node:test';
import assert from 'node:assert/strict';
import { createOtpHandler } from '../api/otp.js';

function responseCapture() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return payload; }
  };
}

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload
});

test('Demo OTP refuses a real account before requesting an OTP', async () => {
  const calls = [];
  const handler = createOtpHandler(async (url) => {
    calls.push(url);
    return jsonResponse(200, { data: [{ account_id: 'CR100', account_type: 'real' }] });
  });
  const res = responseCapture();
  await handler({ method: 'POST', body: { appId: 'app', token: 'token', accountId: 'CR100', demoOnly: true } }, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.payload.error, /REFUSED/);
  assert.equal(calls.length, 1);
});

test('Demo OTP verifies the exact Demo account before returning the trading URL', async () => {
  const calls = [];
  const handler = createOtpHandler(async (url, options) => {
    calls.push({ url, options });
    if (String(url).endsWith('/accounts')) {
      return jsonResponse(200, { data: [{ account_id: 'DOT9001', account_type: 'demo', currency: 'USD', balance: 10000 }] });
    }
    return jsonResponse(200, { data: { url: 'wss://demo.deriv.test/session' } });
  });
  const res = responseCapture();
  await handler({ method: 'POST', body: { appId: 'app', token: 'token', accountId: 'DOT9001', demoOnly: true } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.url, 'wss://demo.deriv.test/session');
  assert.equal(res.payload.account.account_type, 'demo');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
});
