import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('skip link + lang + main landmark', () => {
  assert.match(html, /<html lang="en"/);
  assert.match(html, /class="skip"/);
  assert.match(html, /<main[^>]*id="main"/);
});

test('key inputs have labels', () => {
  for (const id of ['q', 'scanToken', 'qrFile', 'aName', 'aId', 'aCode', 'aRole', 'aChannel']) {
    assert.match(html, new RegExp(`for="${id}"`), `missing label for ${id}`);
  }
});

test('live regions for async results', () => {
  assert.match(html, /aria-live="polite"/);
});

test('print template is a shaped cut-out, not a rectangle card', () => {
  const svg = fs.readFileSync(path.join(root, 'print', 'broken-heart.svg'), 'utf8');
  assert.match(svg, /<path[^>]*C120 260/); // heart curve
  assert.match(svg, /stroke-dasharray/); // break/fold line
  assert.match(svg, /QR here/);
  const print = fs.readFileSync(path.join(root, 'print.html'), 'utf8');
  assert.match(print, /die-cut/i);
});
