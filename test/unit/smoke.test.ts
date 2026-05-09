import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VERSION } from '../../src/index.js';

test('package exports a version string', () => {
  assert.equal(typeof VERSION, 'string');
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});
