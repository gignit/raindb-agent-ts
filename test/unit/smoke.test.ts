// smoke.test.ts -- the public-API contract test.
//
// This is the test that breaks when someone accidentally
// removes/renames an export. Hosts (fdn-app, raindb-app) bind to
// the names checked here; treat any failure as a breaking change.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as agent from '../../src/index.js';

test('package exports a version string', () => {
  assert.equal(typeof agent.VERSION, 'string');
  assert.match(agent.VERSION, /^\d+\.\d+\.\d+/);
});

test('public API exports the runtime', () => {
  assert.equal(typeof agent.runAgent, 'function');
});

test('public API exports the registry helpers', () => {
  assert.equal(typeof agent.buildToolDefs, 'function');
  assert.equal(typeof agent.findTool, 'function');
  assert.equal(typeof agent.toChatTool, 'function');
  assert.equal(typeof agent.defaultRoleAllows, 'function');
});

test('public API exports the arg helpers', () => {
  assert.equal(typeof agent.stringArg, 'function');
  assert.equal(typeof agent.intArg, 'function');
  assert.equal(typeof agent.boolArg, 'function');
  assert.equal(typeof agent.stringSliceArg, 'function');
  assert.equal(typeof agent.objectArg, 'function');
});

test('public API exports the GraphQL client', () => {
  assert.equal(typeof agent.executeGraphQL, 'function');
  assert.equal(typeof agent.RaindbError, 'function');
});

test('public API exports the openai client + model resolver', () => {
  assert.equal(typeof agent.makeRaindbAiClient, 'function');
  assert.equal(typeof agent.resolveDefaultModel, 'function');
  assert.equal(typeof agent.resolveDefaultChatModel, 'function');
});

test('public API exports the system-prompt builder', () => {
  assert.equal(typeof agent.buildSystemPrompt, 'function');
});

test('public API exports the pilot tools', () => {
  assert.equal(agent.pack_list.name, 'pack_list');
  assert.equal(agent.droplet_create.name, 'droplet_create');
  assert.equal(agent.droplet_create.modifiesResource, true);
});

test('public API exports the per-domain catalogs + tenantTools aggregator', () => {
  assert.ok(Array.isArray(agent.marketplaceTools));
  assert.ok(Array.isArray(agent.dropletTools));
  assert.ok(Array.isArray(agent.tenantTools));
  assert.ok(agent.tenantTools.length >= 2, 'M1 has at least the two pilots');
  assert.ok(agent.tenantTools.some((t) => t.name === 'pack_list'));
  assert.ok(agent.tenantTools.some((t) => t.name === 'droplet_create'));
});
