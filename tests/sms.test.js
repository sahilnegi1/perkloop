import test from 'node:test';
import assert from 'node:assert/strict';
import { toE164Indian } from '../src/sms.js';
import { earnCopy, redeemCopy } from '../src/notify.js';

test('indian mobile to E.164', () => {
  assert.equal(toE164Indian('9876543210'), '+919876543210');
  assert.equal(toE164Indian('+919876543210'), '+919876543210');
  assert.throws(() => toE164Indian('5123456789'), /invalid_indian_mobile/);
  assert.throws(() => toE164Indian('123'), /invalid_indian_mobile/);
});

test('notification copy never empty', () => {
  const e = earnCopy({ businessName: 'Cafe', points: 20, stamps: 0 });
  assert.match(e.title, /Cafe/);
  const r = redeemCopy({ businessName: 'Salon', title: 'Free cut' });
  assert.match(r.body, /Free cut/);
});
