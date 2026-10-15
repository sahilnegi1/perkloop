import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, repeatStats } from '../src/export.js';

test('csv escapes commas, quotes, newlines', () => {
  const csv = toCsv([{ a: 'x,y', b: 'q"z', c: 'l1\nl2' }], ['a', 'b', 'c']);
  assert.equal(csv, 'a,b,c\n"x,y","q""z","l1\nl2"');
});

test('repeat stats honest on empty', () => {
  assert.deepEqual(repeatStats([]), { total: 0, repeat: 0, repeatRate: 0 });
  assert.deepEqual(repeatStats([{ visits: 1 }, { visits: 3 }]), { total: 2, repeat: 1, repeatRate: 50 });
});
