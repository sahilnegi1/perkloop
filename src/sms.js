// Phase 6: SMS via Twilio Verify (server-side only). Pure helpers are tested; network calls live in server.js.
export function toE164Indian(phone) {
  const d = String(phone || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  if (!/^[6-9]\d{9}$/.test(d)) throw new Error('invalid_indian_mobile');
  return '+91' + d;
}

export function twilioBasicAuth(sid, token) {
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
}
