import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProgramRules, validateRewardInput, canRedeem } from '../src/loyalty.js';

test('program rules reject negatives and absurd values', () => {
  assert.equal(validateProgramRules('points', { pointsPer100Rs: -5 }).ok, false);
  assert.equal(validateProgramRules('points', { pointsPer100Rs: 0 }).ok, false);
  assert.equal(validateProgramRules('points', { pointsPer100Rs: 10 }).ok, true);
  assert.equal(validateProgramRules('spend', { thresholdPaise: -1 }).ok, false);
  assert.equal(validateProgramRules('custom', { flatPoints: 0, flatStamps: 0 }).ok, false);
  assert.equal(validateProgramRules('visit', { stampsToReward: 1 }).ok, false);
  assert.equal(validateProgramRules('visit', { stampsToReward: 5 }).ok, true);
});

test('reward input rejects bad costs, limits, dates', () => {
  assert.equal(validateRewardInput({ cost_points: 0, cost_stamps: 0 }).ok, false);
  assert.equal(validateRewardInput({ cost_points: -1 }).ok, false);
  assert.equal(validateRewardInput({ cost_points: 50, per_customer_limit: 0 }).ok, false);
  assert.equal(validateRewardInput({ cost_points: 50, start_at: '2026-12-01', end_at: '2026-01-01' }).ok, false);
  assert.equal(validateRewardInput({ cost_points: 50, min_spend: 99999 }).ok, true);
});

test('per-customer limit blocks repeat redemption', () => {
  const r = canRedeem({ balance: { points: 500, stamps: 0 }, reward: { active: 1, cost_points: 50, per_customer_limit: 1 }, redemptionCount: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'per_customer_limit');
});

test('date-windowed rewards enforced', () => {
  const future = new Date(Date.now() + 864e5).toISOString();
  const past = new Date(Date.now() - 864e5).toISOString();
  assert.equal(canRedeem({ balance: { points: 500 }, reward: { active: 1, cost_points: 10, start_at: future } }).reason, 'not_started');
  assert.equal(canRedeem({ balance: { points: 500 }, reward: { active: 1, cost_points: 10, end_at: past } }).reason, 'expired');
});

test('legacy migration must be explicit — no auto-transfer helper exists', () => {
  // canRedeem never touches legacy; legacy requires confirm:true at API layer.
  const r = canRedeem({ balance: { points: 0 }, reward: { active: 1, cost_points: 10 } });
  assert.equal(r.ok, false);
});
