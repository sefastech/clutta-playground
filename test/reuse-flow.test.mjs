import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CloudClient } from '../lib/cloud.mjs';
import { reusableFlow, loadedReusableFlow, reuseIntent } from '../lib/reuse-flow.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const state = { workspaceId: id(1), projectId: id(2), sourceId: id(3), scenario: 'payment-ordering' };
const proposalId = id(4);
function catalog() {
  const scope = { kind: 'project', workspace_id: state.workspaceId, project_id: state.projectId };
  const components = ['payment-api', 'payment-worker', 'notification-scheduler'];
  const events = ['payment.accepted', 'ledger.recorded', 'merchant.notified'];
  return { workspace_id: state.workspaceId, source_id: state.sourceId, route_mode: 'bindings',
    routes: [scope], snapshot_fingerprint: 'snapshot-1', catalog_generation: 2,
    active_chains: [{ proposal_id: proposalId, approval_id: id(5), activation_scope: scope,
      definition_fingerprint: 'definition-1', catalog_generation: 2,
      readiness: { patterns_executable: true, scope_ready: true, source_coverage_ready: true, replay_ready: true,
        correlation_ready: true, outcome_rules_unambiguous: true, blockers: [] },
      definition: { id: id(6), version: 1, origin: 'learned', scope, deadline_ms: 30000,
        correlation_recipe: { join_key: 'payment_id', extractors: events.map((event) => ({ signature_id: event, paths: ['payment_id'] })) },
        steps: events.map((event, index) => ({ id: event, position: index, required: true,
          predecessors: index ? [events[index - 1]] : [],
          patterns: [{ kind: 'field_predicate', expression: `json.event=${event}`, source_selector: { components: [components[index]] } }] })),
      } }],
  };
}
const snapshot = (value) => ({ cache: { workspace_id: state.workspaceId, active_catalog: structuredClone(value) } });

test('current approved source-bound catalog can be reused only after collector loads it', async () => {
  const value = catalog();
  const client = new CloudClient('in-memory-test-key', async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.match(url, /active-chains$/);
    return { ok: true, json: async () => ({ data: value }) };
  });
  const result = await client.request(`/v1/catalog/scan/sources/${state.sourceId}/active-chains`);
  assert.equal(reusableFlow(result.data, proposalId, state).definition.id, id(6));
  assert.equal(loadedReusableFlow(snapshot(value), value, proposalId, state).approval_id, id(5));
});

test('catalog unavailability is an error, not fallback learning', async () => {
  const client = new CloudClient('in-memory-test-key', async () => ({ ok: false, status: 503 }));
  await assert.rejects(client.request(`/v1/catalog/scan/sources/${state.sourceId}/active-chains`), /503/);
});

test('wrong scenario, project, source, scope, pattern, ordering, correlation and approval fail closed', () => {
  const changes = [
    (c) => { c.active_chains = []; },
    (c) => { c.active_chains.push(structuredClone(c.active_chains[0])); },
    (c) => { c.workspace_id = id(99); },
    (c) => { c.source_id = id(99); },
    (c) => { c.routes[0].project_id = id(99); },
    (c) => { c.active_chains[0].activation_scope = { kind: 'workspace', workspace_id: state.workspaceId }; },
    (c) => { c.active_chains[0].approval_id = null; },
    (c) => { c.active_chains[0].readiness.replay_ready = false; },
    (c) => { c.active_chains[0].readiness.blockers = ['not ready']; },
    (c) => { c.active_chains[0].definition.steps[1].patterns[0].expression = 'json.event=notification.queued'; },
    (c) => { c.active_chains[0].definition.steps[1].patterns[0].kind = 'regex'; },
    (c) => { c.active_chains[0].definition.steps[1].patterns[0].source_selector.components = ['other']; },
    (c) => { c.active_chains[0].definition.steps[1].predecessors = []; },
    (c) => { c.active_chains[0].definition.correlation_recipe.extractors[0].paths = ['request_id']; },
    (c) => { c.active_chains[0].definition.correlation_recipe.join_key = 'request_id'; },
    (c) => { c.active_chains[0].definition.steps[0].patterns[0].source_selector.source_ids = [id(99)]; },
    (c) => { c.active_chains[0].definition.steps[0].patterns[0].source_selector.identifier_prefix = 'old-host'; },
    (c) => { c.active_chains[0].definition.correlation_recipe.extractors[0].capture = 'other'; },
    (c) => { c.active_chains[0].definition.correlation_recipe.extractors[0].source_selector = { components: ['other'] }; },
    (c) => { c.active_chains[0].definition.correlation_recipe.extractors[0].source_selector = { source_ids: [id(99)] }; },
  ];
  for (const mutate of changes) {
    const value = catalog(); mutate(value);
    assert.throws(() => reusableFlow(value, proposalId, state));
  }
  assert.throws(() => reusableFlow(catalog(), proposalId, { ...state, scenario: 'scheduler' }), /scenario/);
});

test('stale or missing collector authority does not pass reuse loading', () => {
  const value = catalog();
  for (const mutate of [
    (s) => { s.cache.active_catalog.snapshot_fingerprint = 'stale'; },
    (s) => { s.cache.active_catalog.catalog_generation = 1; },
    (s) => { s.cache.active_catalog.active_chains = []; },
    (s) => { s.cache.active_catalog.active_chains[0].approval_id = id(99); },
  ]) {
    const local = snapshot(value); mutate(local);
    assert.equal(loadedReusableFlow(local, value, proposalId, state), null);
  }
  const wrong = snapshot(value);
  wrong.cache.active_catalog.active_chains[0].activation_scope.project_id = id(99);
  assert.throws(() => loadedReusableFlow(wrong, value, proposalId, state));
});

test('persisted intent cannot replace a proposal or cross accounts on retry', () => {
  const intent = { ...state, proposalId };
  assert.equal(reuseIntent(intent, state), intent);
  assert.equal(reuseIntent(intent, { ...state, proposalId }), intent);
  for (const field of ['workspaceId', 'projectId', 'scenario', 'proposalId']) {
    assert.throws(() => reuseIntent(intent, { ...state, [field]: id(99) }));
  }
});

test('reuse start disables discovery and exits before the learning branch', () => {
  const script = readFileSync(new URL('../lab', import.meta.url), 'utf8');
  assert.match(script, /enabled: \$\{session\.reusedFlow \? 'false' : 'true'\}/);
  assert.match(script, /if \(existsSync\(reuseFile\)\) return reuseIntent\(owned\(reuseFile\), target\);\n  if \(!args\.includes\('--existing-flow'\)\) return null;/);
  assert.ok(script.indexOf('save(reuseFile, intent)') < script.indexOf('async function start('));
  const reuseBranch = script.slice(script.indexOf('if (session.reusedFlow) {'), script.indexOf('if (session.proposalId) {'));
  assert.match(reuseBranch, /await activation\(client, session\)/);
  assert.match(reuseBranch, /return;/);
  assert.doesNotMatch(reuseBranch, /work\('traffic'/);
});
