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

test('public API exports the M1 pilot tools', () => {
  assert.equal(agent.pack_list.name, 'pack_list');
  assert.equal(agent.droplet_create.name, 'droplet_create');
  assert.equal(agent.droplet_create.modifiesResource, true);
});

test('public API exports the M2 marketplace tools', () => {
  assert.equal(agent.pack_info.name, 'pack_info');
  assert.equal(agent.pack_get.name, 'pack_get');
  assert.equal(agent.pack_features.name, 'pack_features');
  assert.equal(agent.vendor_list.name, 'vendor_list');
  assert.equal(agent.vendor_info.name, 'vendor_info');
});

test('public API exports the M2 formation tools', () => {
  assert.equal(agent.formation_list.name, 'formation_list');
  assert.equal(agent.formation_describe.name, 'formation_describe');
  assert.equal(agent.formation_publish.name, 'formation_publish');
  assert.equal(agent.formation_publish.modifiesResource, true);
});

test('public API exports the M2 cache + config tools', () => {
  assert.equal(agent.cache_stats_my.name, 'cache_stats_my');
  assert.equal(agent.config_get.name, 'config_get');
});

test('public API exports the per-domain catalogs + tenantTools aggregator', () => {
  assert.ok(Array.isArray(agent.marketplaceTools));
  assert.ok(Array.isArray(agent.dropletTools));
  assert.ok(Array.isArray(agent.formationTools));
  assert.ok(Array.isArray(agent.cacheTools));
  assert.ok(Array.isArray(agent.configTools));
  assert.ok(Array.isArray(agent.tenantTools));
  // Names that must appear in the aggregated table.
  const names = agent.tenantTools.map((t) => t.name);
  for (const n of [
    'pack_list', 'pack_info', 'pack_get', 'pack_features',
    'vendor_list', 'vendor_info',
    'droplet_create',
    'formation_list', 'formation_describe', 'formation_publish',
    'cache_stats_my',
    'config_get',
  ]) {
    assert.ok(names.includes(n), `tenantTools must include ${n}`);
  }
});
