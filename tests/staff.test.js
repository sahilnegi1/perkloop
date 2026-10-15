import test from 'node:test';
import assert from 'node:assert/strict';
import { canDo } from '../src/permissions.js';

test('owner can do everything', () => {
  for (const a of ['program.manage', 'reward.manage', 'outlet.manage', 'staff.manage', 'business.edit', 'qr.issue', 'redeem.decide']) {
    assert.equal(canDo({ membershipRole: 'owner', action: a }), true, a);
  }
});

test('staff can operate but not manage', () => {
  assert.equal(canDo({ membershipRole: 'staff', action: 'qr.issue' }), true);
  assert.equal(canDo({ membershipRole: 'staff', action: 'redeem.decide' }), true);
  assert.equal(canDo({ membershipRole: 'staff', action: 'transactions.read' }), true);
  assert.equal(canDo({ membershipRole: 'staff', action: 'program.manage' }), false);
  assert.equal(canDo({ membershipRole: 'staff', action: 'reward.manage' }), false);
  assert.equal(canDo({ membershipRole: 'staff', action: 'staff.manage' }), false);
  assert.equal(canDo({ membershipRole: 'staff', action: 'business.edit' }), false);
});

test('outsiders can do nothing', () => {
  assert.equal(canDo({ membershipRole: null, action: 'qr.issue' }), false);
  assert.equal(canDo({ membershipRole: undefined, action: 'business.read' }), false);
});
