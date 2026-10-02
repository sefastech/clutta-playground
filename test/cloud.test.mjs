import test from 'node:test';
import assert from 'node:assert/strict';
import { API_URL, CloudClient, requiredScopes, uuid, validateAccount, assertRoutes,
  assertSource, readSource, assertCoverage, assertDefinition, loadedActivation,
  evidencePayment, localInstance, assertInstance, assertCaseMember } from '../lib/cloud.mjs';

// These are in-memory canonical wire fixtures, not Cloud outputs or real keys.
const state = Object.freeze({
  workspaceId: '10000000-0000-4000-8000-000000000001',
  projectId: '10000000-0000-4000-8000-000000000002',
  sourceId: '10000000-0000-4000-8000-000000000003',
  installationId: '10000000-0000-4000-8000-000000000004',
  agentName: 'clutta-playground-in-memory-fixture',
});
const otherId = '20000000-0000-4000-8000-000000000001';
const paymentId = '30000000-0000-4000-8000-000000000001';
const instanceId = '40000000-0000-4000-8000-000000000001';
const now = Date.UTC(2026, 9, 3, 12, 0, 20);
const roles = ['api', 'worker', 'scheduler'];
const serviceNames = ['payment-api', 'payment-worker', 'notification-scheduler'];
const events = ['payment.accepted', 'notification.queued', 'notification.delivered'];
const writeScopes = ['write:scan.sources', 'write:scan.evidence', 'write:scan.detected-chains'];
const copy = (value) => structuredClone(value);
// composeSourceID preserves the provider path's leading slash on the wire.
const evidenceSource = (index) => `${state.agentName}/file//var/log/clutta-playground/${roles[index]}.log`;

function route() {
  return { workspace_id: state.workspaceId, scope_type: 'project', scope_id: state.projectId,
    team_id: '10000000-0000-4000-8000-000000000005', project_id: state.projectId };
}

function definition() {
  return { id: '50000000-0000-4000-8000-000000000001', version: 1,
    name: 'Fake payment notification', origin: 'learned',
    scope: { kind: 'project', workspace_id: state.workspaceId,
      team_id: route().team_id, project_id: state.projectId },
    steps: roles.map((role, index) => ({ id: `step-${role}`, position: index, required: true,
      predecessors: index ? [`step-${roles[index - 1]}`] : [],
      patterns: [{ id: `pattern-${role}`, version: 1, kind: 'token_template',
        expression: `service=${serviceNames[index]} event=${events[index]} payment_id={}`,
        compiler_version: 'fixture-v1', source_selector: { components: [serviceNames[index]] } }],
    })),
    correlation_recipe: { id: 'payment-identity', version: 1, join_key: 'payment_id',
      extractors: roles.map((role) => ({ signature_id: `step-${role}`, paths: ['payment_id'] })),
      digest_strategy: 'workspace_hmac_sha256', tier: 'exact', coverage: 1, purity: 1,
      collision_count: 0, compiler_version: 'fixture-v1' },
    deadline_ms: 10000,
  };
}

function activation() {
  return { schema_version: 1, definition: definition(), definition_fingerprint: 'a'.repeat(64),
    proposal_id: 'fixture-proposal', approval_id: '60000000-0000-4000-8000-000000000001',
    activation_scope: copy(definition().scope), catalog_generation: 7, activated_at_ms: now - 1000,
    activated_by: '60000000-0000-4000-8000-000000000002',
    readiness: { patterns_executable: true, scope_ready: true, source_coverage_ready: true,
      replay_ready: true, correlation_ready: true, outcome_rules_unambiguous: true },
  };
}

function catalog() {
  const { scope_type, scope_id, ...scope } = route();
  return { schema_version: 1, workspace_id: state.workspaceId, source_id: state.sourceId,
    route_mode: 'bindings', routes: [{ kind: 'project', ...scope }],
    catalog_generation: 7, active_chains: [activation()],
    snapshot_fingerprint: 'b'.repeat(64), generated_at_ms: now,
  };
}

function source() {
  return { id: state.sourceId, workspace_id: state.workspaceId, source_identifier: state.agentName,
    hostname: state.agentName, source_kind: 'file', agent_version: 'v0.2.20', state: 'active',
    registered_at: new Date(now - 60000).toISOString(), last_seen_at: new Date(now - 1000).toISOString() };
}

function bindings() {
  return [{ ...route(), source_id: state.sourceId, created_at: new Date(now - 60000).toISOString() }];
}

function health() {
  return { id: state.sourceId, state: 'active', healthy: true,
    last_seen_at: new Date(now - 1000).toISOString(), secs_since_last_seen: 1,
    healthy_reason: 'source is active and heartbeating' };
}

function snapshot() {
  return { daemon: { pid: 123, phase: 'realtime', written_at: new Date(now - 1000).toISOString(),
    coverage: { total: 3, running: 3, failed: 0 },
    sources: roles.map((role) => ({ name: `file:/var/log/clutta-playground/${role}.log`,
      kind: 'file', status: 'running', events: 600, states: 0 })) },
    sync: { installation_id: state.installationId, heartbeat_accepted_at: new Date(now - 1000).toISOString(),
      heartbeat_consecutive_errors: 0, pulse_consecutive_errors: 0 },
    cache: { fetched_at: new Date(now - 1000).toISOString(), workspace_id: state.workspaceId,
      active_catalog: catalog(), etag: `"${'b'.repeat(64)}"` },
  };
}

function evidence(index = 0, id = paymentId) {
  return { source_id: evidenceSource(index), reference: `line:${index + 1}`,
    raw: JSON.stringify({ time: new Date(now - 1000 + index).toISOString(), level: 'info',
      service: serviceNames[index], event: events[index], payment_id: id, amount_cents: 1299, currency: 'USD' }),
    line_number: index + 1, timestamp_ms: now - 1000 + index,
    component: serviceNames[index], fingerprint: String(index + 1).repeat(64) };
}

function pulse(index = 0, id = paymentId) {
  return { uuid: `pulse-${index}`, workspace_id: state.workspaceId, installation_id: state.installationId,
    chain_id: activation().definition.id, chain_version: 1, instance_id: instanceId, correlation_id: instanceId,
    source_id: evidenceSource(index),
    signature_id: `step-${roles[index]}`, created_at: now - 1000 + index,
    match_result: { schema_version: 1, matched: true, authoritative: true,
      chain_id: activation().definition.id, chain_version: 1, catalog_generation: 7,
      activation_scope: copy(definition().scope), signature_id: `step-${roles[index]}`,
      pattern_id: `pattern-${roles[index]}`, pattern_version: 1, correlation_recipe_id: 'payment-identity',
      correlation_tier: 'exact', installation_id: state.installationId,
      source_id: evidenceSource(index), evidence: evidence(index, id) },
  };
}

function instance() {
  return { instance_id: instanceId, workspace_id: state.workspaceId, installation_id: state.installationId,
    chain_id: definition().id, chain_version: 1, correlation_id: instanceId, state: 'completed',
    started_at_ms: now - 1000, completed_at_ms: now - 998, deadline_at_ms: now + 9000,
    registered_source_id: state.sourceId, routes: [route()], signatures_fired: roles.map((role) => `step-${role}`),
    lineage: { availability: 'available', definition_available: true,
      observations_complete: true, violations_complete: true, catalog_generation: 7,
      definition_fingerprint: activation().definition_fingerprint,
      definition: { id: definition().id, version: 1, name: definition().name,
        kind: 'learned', deadline_ms: 10000, steps: definition().steps.map(({ patterns, ...step }) => step) },
      observations: roles.map((role, index) => ({ pulse_id: `pulse-${index}`, signature_id: `step-${role}`,
        registered_source_id: state.sourceId, source_id: pulse(index).source_id,
        matched_at_ms: now - 1000 + index, routes: [route()],
        match: { authoritative: true, catalog_generation: 7, signature_id: `step-${role}`,
          pattern_id: `pattern-${role}`, pattern_version: 1, correlation_tier: 'exact',
          source_id: evidence(index).source_id, evidence: evidence(index) } })), violations: [] },
  };
}

function member() {
  const row = instance();
  delete row.lineage;
  return { instance: { ...row, state: 3, signatures_fired: ['step-api', 'step-worker'] },
    violation: { schema_version: 1, id: 'fixture-violation', idempotency_key: 'fixture-dedupe',
      pattern_key: 'fixture-missing-final-step', workspace_id: state.workspaceId,
      team_id: route().team_id, project_id: state.projectId, installation_ids: [state.installationId],
      instance_id: instanceId, chain_id: definition().id, chain_version: 1, catalog_generation: 7,
      pattern_id: 'pattern-scheduler', pattern_version: 1, correlation_recipe_id: 'payment-identity',
      correlation_tier: 'exact', kind: 'missing_step', expected_signature_id: 'step-scheduler',
      expected_at_ms: now + 9000, occurred_at_ms: now + 10000, source_health: 'ready',
      evidence: [evidence(0), evidence(1)] }, contributed_at_server: new Date(now + 10000).toISOString() };
}

test('UI identifiers are nonzero UUIDs, not paths or empty tenant guesses', () => {
  assert.equal(uuid(state.workspaceId.toUpperCase()), state.workspaceId);
  for (const value of [null, '', '../another-workspace', '00000000-0000-0000-0000-000000000000']) {
    assert.throws(() => uuid(value));
  }
});

test('padded keys normalize before headers while blank and internally malformed credentials stay invalid', async () => {
  const fixtureKey = 'only-an-offline-fixture';
  const calls = [];
  const client = new CloudClient(`\r\n \t\u00a0${fixtureKey}\u00a0 \t\r\n`, async (url, options) => {
    calls.push(options);
    return { ok: true, json: async () => ({}) };
  });
  await client.request('/v1/api-keys/validate');
  assert.equal(calls[0].headers['X-CLUTTA-KEY'], fixtureKey);
  for (const invalid of ['', ' \t\r\n', null, 5, 'first second', 'first\tsecond', 'first\r\nsecond', 'first\u0000second']) {
    assert.throws(() => new CloudClient(invalid), /valid workspace key/);
  }
});

test('Cloud reads pin the HTTPS origin, refuse redirects, and do not expose key-bearing transport errors', async () => {
  const fixtureKey = 'in-memory-fixture-not-a-real-key';
  const calls = [];
  const client = new CloudClient(fixtureKey, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ data: { isValid: true } }) };
  });
  await client.request('/v1/api-keys/validate');
  assert.equal(calls[0].url, `${API_URL}/v1/api-keys/validate`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['X-CLUTTA-KEY'], fixtureKey);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  await assert.rejects(client.request('https://example.invalid/v1/api-keys/validate'));
  assert.equal(calls.length, 1);
  const failing = new CloudClient(fixtureKey, async () => { throw new Error(fixtureKey); });
  await assert.rejects(failing.request('/v1/api-keys/validate'), (error) => {
    assert.ok(!error.message.includes(fixtureKey));
    assert.match(error.message, /no readiness was assumed/);
    return true;
  });
  assert.throws(() => new CloudClient('fixture\r\ninjected-header'));
});

test('HTTP denials and malformed responses stay unavailable rather than implying an incident', async () => {
  for (const status of [401, 403, 404, 429, 500, 504]) {
    const client = new CloudClient('in-memory-fixture', async () => ({ ok: false, status }));
    await assert.rejects(client.request('/v1/api-keys/validate'));
  }
  const malformed = new CloudClient('in-memory-fixture', async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }));
  await assert.rejects(malformed.request('/v1/api-keys/validate'), /unverified/);
  const notArrived = new CloudClient('in-memory-fixture', async () => ({ ok: false, status: 404 }));
  assert.equal(await notArrived.request(`/v1/incident/scan/instances/${instanceId}`, { allowNotFound: true }), null);
});

test('account validation requires canonical workspace ownership and both runtime writes and evidence reads', async () => {
  const data = { isValid: true, workspaceId: state.workspaceId, teamId: route().team_id,
    scopes: [...requiredScopes, ...writeScopes] };
  const client = (value) => ({ request: async (path) => { assert.equal(path, '/v1/api-keys/validate'); return { data: value }; } });
  assert.equal((await validateAccount(client(data), state.workspaceId)).workspaceId, state.workspaceId);
  await validateAccount(client({ ...data, scopes: ['*'] }), state.workspaceId);
  for (const invalid of [{ ...data, isValid: false }, { ...data, workspaceId: otherId },
    { ...data, workspaceId: undefined }, { ...data, scopes: [] }, { ...data, scopes: undefined }]) {
    await assert.rejects(validateAccount(client(invalid), state.workspaceId));
  }
  for (const scope of [...new Set([...requiredScopes, ...writeScopes])]) {
    await assert.rejects(validateAccount(client({ ...data, scopes: data.scopes.filter((value) => value !== scope) }), state.workspaceId),
      `Missing ${scope} must fail before the collector is launched`);
  }
});

test('routing accepts one owned project only and never repairs broad bindings behind the evaluator', () => {
  assertRoutes([route()], state);
  for (const invalid of [[], [route(), { ...route(), project_id: otherId }],
    [{ ...route(), scope_type: 'team', project_id: undefined }],
    [{ ...route(), workspace_id: otherId }], [{ ...route(), project_id: otherId }]]) {
    assert.throws(() => assertRoutes(invalid, state));
  }
  assertSource(source(), bindings(), catalog(), state);
  for (const field of ['id', 'workspace_id', 'source_identifier', 'hostname', 'source_kind']) {
    assert.throws(() => assertSource({ ...source(), [field]: 'not-this-run' }, bindings(), catalog(), state));
  }
  assert.throws(() => assertSource(source(), [{ ...bindings()[0], source_id: otherId }], catalog(), state));
  assert.throws(() => assertSource(source(), [{ ...bindings()[0], scope_id: otherId }], catalog(), state));
  assert.throws(() => assertSource(source(), bindings(), { ...catalog(), source_id: otherId }, state));
  assert.throws(() => assertSource(source(), bindings(), { ...catalog(), route_mode: 'workspace', routes: [] }, state));
});

test('source inspection uses authenticated nonmutating registered-source APIs and canonical response wrappers', async () => {
  const prefix = `/v1/catalog/scan/sources/${state.sourceId}`;
  const responses = { [prefix]: { data: source() }, [`${prefix}/bindings`]: { data: bindings() },
    [`${prefix}/active-chains`]: { data: catalog() }, [`${prefix}/health`]: { data: health() } };
  const paths = [];
  const result = await readSource({ request: async (path, options) => {
    assert.equal(options, undefined);
    paths.push(path);
    return responses[path];
  } }, state);
  assert.deepEqual(paths.sort(), Object.keys(responses).sort());
  assert.equal(result.health.healthy, true);
});

test('daemon coverage requires three owned file sources, recent accepted heartbeat, and available Cloud health', () => {
  assertCoverage(snapshot(), health(), now);
  const changes = [
    (value) => { value.daemon.phase = 'bootstrap'; },
    (value) => { value.daemon.written_at = new Date(now - 30001).toISOString(); },
    (value) => { value.daemon.written_at = new Date(now + 5001).toISOString(); },
    (value) => { value.daemon.coverage.running = 2; value.daemon.coverage.failed = 1; },
    (value) => { value.daemon.coverage.total = 4; },
    (value) => { value.daemon.sources[0].name = 'file:/var/log/production.log'; },
    (value) => { value.daemon.sources[1].name = value.daemon.sources[0].name; },
    (value) => { value.daemon.sources[0].status = 'failed'; },
    (value) => { value.sync.heartbeat_accepted_at = new Date(now - 90001).toISOString(); },
    (value) => { delete value.sync.heartbeat_accepted_at; },
    (value) => { value.sync.heartbeat_consecutive_errors = 1; },
    (value) => { value.sync.pulse_consecutive_errors = 1; },
  ];
  for (const change of changes) { const value = snapshot(); change(value); assert.throws(() => assertCoverage(value, health(), now)); }
  for (const invalid of [undefined, { ...health(), healthy: false }, { ...health(), state: 'retired' }]) {
    assert.throws(() => assertCoverage(snapshot(), invalid, now));
  }
});

test('the demo definition requires three real anchored steps and an unchanged bounded learned deadline', () => {
  assertDefinition(definition(), state);
  const changes = [
    (value) => { value.origin = 'builtin'; },
    (value) => { value.scope.workspace_id = otherId; },
    (value) => { value.scope.project_id = otherId; },
    (value) => { value.correlation_recipe.join_key = 'amount_cents'; },
    (value) => { value.steps.pop(); },
    (value) => { value.steps[2].required = false; },
    (value) => { value.steps[1].patterns = []; },
    (value) => { value.steps[1].patterns[0].expression = '{} {} {}'; },
    (value) => { value.deadline_ms = 999; },
    (value) => { value.deadline_ms = 120001; },
  ];
  for (const change of changes) { const value = definition(); change(value); assert.throws(() => assertDefinition(value, state)); }
});

test('loaded activation requires the same source-bound daemon cache and exact human-approved version', () => {
  assert.equal(loadedActivation(snapshot(), catalog(), 'fixture-proposal', state).approval_id, activation().approval_id);
  assert.equal(loadedActivation(snapshot(), catalog(), 'another-proposal', state), null);
  const changes = [
    (value) => { value.cache.workspace_id = otherId; },
    (value) => { value.cache.active_catalog.workspace_id = otherId; },
    (value) => { value.cache.active_catalog.source_id = otherId; },
    (value) => { value.cache.active_catalog.snapshot_fingerprint = 'c'.repeat(64); },
    (value) => { value.cache.active_catalog.catalog_generation = 6; },
    (value) => { value.cache.active_catalog.active_chains[0].approval_id = 'another-approval'; },
    (value) => { value.cache.active_catalog.active_chains[0].definition_fingerprint = 'c'.repeat(64); },
    (value) => { value.cache.active_catalog.active_chains[0].definition.version = 2; },
    (value) => { value.cache.active_catalog.active_chains[0].catalog_generation = 6; },
  ];
  for (const change of changes) { const value = snapshot(); change(value); assert.equal(loadedActivation(value, catalog(), 'fixture-proposal', state), null); }
  for (const field of ['patterns_executable', 'scope_ready', 'source_coverage_ready', 'replay_ready', 'correlation_ready', 'outcome_rules_unambiguous']) {
    const value = catalog(); value.active_chains[0].readiness[field] = false;
    assert.throws(() => loadedActivation(snapshot(), value, 'fixture-proposal', state));
  }
  const unapproved = catalog(); delete unapproved.active_chains[0].approval_id;
  assert.throws(() => loadedActivation(snapshot(), unapproved, 'fixture-proposal', state));
});

test('payment association reads actual cited JSON, not a filename, keyword, or public correlation identifier', () => {
  assert.equal(evidencePayment(evidence()), paymentId);
  assert.equal(evidencePayment({ raw: 'payment failed somewhere' }), null);
  assert.equal(evidencePayment({ raw: 'not JSON' }), null);
  assert.equal(localInstance([pulse()], paymentId, activation(), state), instanceId);
  assert.notEqual(pulse().correlation_id, paymentId);
  assert.equal(localInstance([{ ...pulse(0, otherId), correlation_id: paymentId }], paymentId, activation(), state), null);
  assert.equal(localInstance([{ ...pulse(), workspace_id: otherId }], paymentId, activation(), state), null);
  assert.equal(localInstance([{ ...pulse(), installation_id: otherId }], paymentId, activation(), state), null);
  assert.equal(localInstance([{ ...pulse(), source_id: 'another-agent/file//var/log/clutta-playground/api.log' }], paymentId, activation(), state), null);
  assert.throws(() => localInstance([pulse(), { ...pulse(1), instance_id: otherId }], paymentId, activation(), state), /split/);
});

test('healthy backend lineage proves all required steps, owned routes, and no violations', () => {
  assertInstance(instance(), paymentId, activation(), state);
  const changes = [
    (value) => { value.registered_source_id = otherId; },
    (value) => { value.installation_id = otherId; },
    (value) => { value.workspace_id = otherId; },
    (value) => { value.routes.push({ ...route(), project_id: otherId }); },
    (value) => { value.lineage.availability = 'partial'; },
    (value) => { value.lineage.availability = 'details_purged'; },
    (value) => { value.lineage.observations_complete = false; },
    (value) => { value.lineage.violations_complete = false; },
    (value) => { value.lineage.definition_fingerprint = 'c'.repeat(64); },
    (value) => { value.lineage.catalog_generation = 6; },
    (value) => { value.signatures_fired.pop(); },
    (value) => { value.state = 'in_progress'; },
    (value) => { value.lineage.violations.push({ kind: 'missing_step' }); },
    (value) => { value.lineage.observations[1].match.authoritative = false; },
    (value) => { value.lineage.observations[1].registered_source_id = otherId; },
    (value) => { value.lineage.observations[1].source_id = 'another-agent/file//var/log/clutta-playground/worker.log'; },
    (value) => { value.lineage.observations = value.lineage.observations.slice(0, 1); },
    (value) => { value.lineage.observations[1].match.evidence = evidence(1, otherId); },
  ];
  for (const change of changes) { const value = instance(); change(value); assert.throws(() => assertInstance(value, paymentId, activation(), state)); }
});

test('healthy required signatures prove the actual ordered API, worker, and scheduler business records', () => {
  // Match the committed logger JSON rather than translating it into invented events.
  assert.deepEqual(events, ['payment.accepted', 'notification.queued', 'notification.delivered']);
  assert.deepEqual(serviceNames, ['payment-api', 'payment-worker', 'notification-scheduler']);
  const reordered = activation();
  reordered.definition.steps = [reordered.definition.steps[2], reordered.definition.steps[0], reordered.definition.steps[1]];
  assertInstance(instance(), paymentId, reordered, state);
  const changes = [
    ['wrong final event', (value) => {
      const record = value.lineage.observations[2].match.evidence;
      record.raw = JSON.stringify({ ...JSON.parse(record.raw), event: 'notification.queued' });
    }],
    ['wrong service in retained JSON', (value) => {
      const record = value.lineage.observations[2].match.evidence;
      record.raw = JSON.stringify({ ...JSON.parse(record.raw), service: 'payment-worker' });
    }],
    ['one API source replayed as all three signatures', (value) => {
      for (const observation of value.lineage.observations) {
        observation.source_id = evidenceSource(0);
        observation.match.source_id = evidenceSource(0);
        observation.match.evidence = evidence(0);
      }
    }],
    ['three event records attached to the wrong ordered signatures', (value) => {
      const observations = value.lineage.observations;
      [observations[0].match.evidence, observations[1].match.evidence] =
        [observations[1].match.evidence, observations[0].match.evidence];
      for (const observation of observations) {
        observation.source_id = observation.match.evidence.source_id;
        observation.match.source_id = observation.source_id;
      }
    }],
  ];
  for (const [label, change] of changes) {
    const value = instance();
    change(value);
    assert.throws(() => assertInstance(value, paymentId, activation(), state), label);
  }
});

test('paused instances may remain pending but still need authoritative retained evidence for that payment', () => {
  const pending = instance();
  pending.state = 'in_progress';
  pending.signatures_fired = ['step-api', 'step-worker'];
  pending.lineage.observations.pop();
  assertInstance(pending, paymentId, activation(), state, { complete: false });
  assert.throws(() => assertInstance(pending, otherId, activation(), state, { complete: false }));
});

test('Case File membership proves this instance and missing final step even when the aggregate represents an older occurrence', () => {
  const aggregate = { id: 'fixture-case', chain: { instance_id: 'older-representative-instance' } };
  assert.notEqual(aggregate.chain.instance_id, instanceId);
  assertCaseMember(member(), instanceId, activation(), state, paymentId);
  const changes = [
    (value) => { value.instance.instance_id = aggregate.chain.instance_id; },
    (value) => { value.violation.instance_id = aggregate.chain.instance_id; },
    (value) => { value.instance.registered_source_id = otherId; },
    (value) => { value.instance.installation_id = otherId; },
    (value) => { value.violation.installation_ids = [otherId]; },
    (value) => { value.violation.workspace_id = otherId; },
    (value) => { value.violation.project_id = otherId; },
    (value) => { value.violation.catalog_generation = 6; },
    (value) => { value.violation.kind = 'explicit_failure'; },
    (value) => { value.violation.expected_signature_id = 'step-worker'; },
    (value) => { value.violation.source_health = 'unknown'; },
    (value) => { value.violation.source_health = 'degraded'; },
    (value) => { value.violation.occurred_at_ms = value.violation.expected_at_ms - 1; },
    (value) => { value.violation.evidence = []; },
    (value) => { value.violation.evidence[0].raw = ''; },
    (value) => { value.violation.evidence[0].raw = JSON.stringify({ payment_id: otherId }); },
    (value) => { value.violation.evidence[0].source_id = 'another-agent/file//var/log/clutta-playground/api.log'; },
    (value) => { delete value.violation.evidence[0].fingerprint; },
    (value) => { value.instance.routes = []; },
  ];
  for (const change of changes) { const value = member(); change(value); assert.throws(() => assertCaseMember(value, instanceId, activation(), state, paymentId)); }
});

test('Case membership uses canonical step position rather than JSON array order for the final required step', () => {
  const active = activation();
  active.definition.steps = [active.definition.steps[2], active.definition.steps[0], active.definition.steps[1]];
  assertCaseMember(member(), instanceId, active, state, paymentId);
});
