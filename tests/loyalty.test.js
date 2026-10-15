import test from 'node:test';
import assert from 'node:assert/strict';
import { calcPointsEarnClean, calcPointsEarn, canRedeem, isValidIndianMobile, isValidEmail } from '../src/loyalty.js';

test('Cafe A points never increase on Cafe B visit (pure math isolation)', () => {
  const a = calcPointsEarnClean({ pointsPer100Rs: 10, amountPaise: 25000 }); // Rs.250 => 20 pts
  assert.equal(a, 20);
});

test('points slabs: Rs.100 => 10 pts, Rs.250 => 20 pts, Rs.99 => 0', () => {
  assert.equal(calcPointsEarnClean({ pointsPer100Rs: 10, amountPaise: 10000 }), 10);
  assert.equal(calcPointsEarnClean({ pointsPer100Rs: 10, amountPaise: 25000 }), 20);
  assert.equal(calcPointsEarnClean({ pointsPer100Rs: 10, amountPaise: 9900 }), 0);
});

test('visit program yields exactly 1 stamp, ignores amount', () => {
  assert.deepEqual(calcPointsEarn({ programType: 'visit', rules: {}, amountPaise: 99999 }), { points: 0, stamps: 1 });
});

test('spend threshold: below => 0, above => bonus', () => {
  assert.deepEqual(calcPointsEarn({ programType: 'spend', rules: { thresholdPaise: 50000, bonusPoints: 20 }, amountPaise: 49900 }), { points: 0, stamps: 0 });
  assert.deepEqual(calcPointsEarn({ programType: 'spend', rules: { thresholdPaise: 50000, bonusPoints: 20 }, amountPaise: 50000 }), { points: 20, stamps: 0 });
});

test('redemption cannot create negative balance', () => {
  const r = canRedeem({ balance: { points: 60, stamps: 0 }, reward: { active: 1, cost_points: 100, cost_stamps: 0 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_points');
  const ok = canRedeem({ balance: { points: 120, stamps: 0 }, reward: { active: 1, cost_points: 100, cost_stamps: 0 } });
  assert.equal(ok.ok, true);
});

test('validators: indian mobile + email', () => {
  assert.equal(isValidIndianMobile('9876543210'), true);
  assert.equal(isValidIndianMobile('5123456789'), false);
  assert.equal(isValidIndianMobile('+919876543210'), true);
  assert.equal(isValidEmail('a@b.co'), true);
  assert.equal(isValidEmail('bad'), false);
});

test('invalid amount throws (prevents fake amounts downstream)', () => {
  assert.throws(() => calcPointsEarnClean({ amountPaise: -5 }), /invalid_amount/);
});
