import { readFileSync } from 'node:fs';
import { trimInput } from '../scenarios/scheduler/src/input.mjs';

export const API_URL = 'https://api.clutta.io';
export const APP_URL = 'https://app.clutta.io';
export const requiredScopes = [
  'read:scan.sources', 'read:scan.source-bindings', 'read:scan.pulse-chains',
  'read:scan.inference', 'read:scan.pulse-chain-instances', 'read:scan.case-files',
  'write:scan.sources', 'write:scan.evidence', 'write:scan.detected-chains',
];

export function uuid(value, label = 'Identifier') {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ||
      value === '00000000-0000-0000-0000-000000000000') throw new Error(`${label} must be a nonzero UUID from your Clutta UI`);
  return value.toLowerCase();
}

export class CloudClient {
  #key;
  #fetch;
  constructor(key, fetchImpl = fetch) {
    const normalized = trimInput(key);
    if (typeof normalized !== 'string' || !normalized || /[\s\u0000-\u001f\u007f]/u.test(normalized)) throw new Error('Enter a valid workspace key using the masked prompt');
    this.#key = normalized;
    this.#fetch = fetchImpl;
  }
  async request(route, { method = 'GET', body, allowNotFound = false } = {}) {
    if (!route.startsWith('/v1/') || route.includes('://')) throw new Error('Only supported Clutta API routes are permitted');
    let response;
    try {
      response = await this.#fetch(`${API_URL}${route}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'X-CLUTTA-KEY': this.#key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error('Clutta could not be reached. Check the connection, then retry; no readiness was assumed.'); }
    if (response.status === 404 && allowNotFound) return null;
    if (!response.ok) {
      const hint = response.status === 401 ? 'Key rejected. Obtain your workspace key from Access keys.' :
        response.status === 403 ? 'Access denied. Check the workspace, project, and key scopes in Connections.' :
          `Clutta returned HTTP ${response.status}. Retry after the service is available.`;
      throw new Error(hint);
    }
    try { return await response.json(); }
    catch { throw new Error('Clutta returned an unreadable response; the step remains unverified.'); }
  }
}

export async function validateAccount(client, workspaceId) {
  const result = await client.request('/v1/api-keys/validate');
  if (result.data?.isValid !== true || result.data.workspaceId !== uuid(workspaceId, 'Workspace ID')) {
    throw new Error('The key does not prove ownership of the selected workspace. No lab traffic was sent.');
  }
  const scopes = result.data.scopes;
  if (!Array.isArray(scopes) || !requiredScopes.every((scope) => scopes.includes(scope) || scopes.includes('*'))) {
    throw new Error('This key lacks the lab\'s Scan read/write scopes. Use the scopes documented in onboarding.');
  }
  return result.data;
}

export function assertRoutes(routes, state) {
  if (!Array.isArray(routes) || routes.length !== 1) throw new Error('Source routing is not exclusive to this demo project. No new traffic will be sent.');
  const route = routes[0];
  if (route.workspace_id !== state.workspaceId || route.project_id !== state.projectId ||
      (route.kind ?? route.scope_type) !== 'project') throw new Error('Evidence routing differs from the chosen workspace/project.');
}

export function assertSource(detail, bindings, catalog, state) {
  if (detail.id !== state.sourceId || detail.workspace_id !== state.workspaceId || detail.source_identifier !== state.agentName ||
      detail.hostname !== state.agentName || detail.source_kind !== 'file') throw new Error('Registered source identity does not match this owned lab.');
  assertRoutes(bindings, state);
  if (bindings[0].source_id !== state.sourceId || bindings[0].scope_id !== state.projectId) throw new Error('Unexpected source binding identity.');
  if (catalog.workspace_id !== state.workspaceId || catalog.source_id !== state.sourceId || catalog.route_mode !== 'bindings') {
    throw new Error('Active catalog is not bound to this registered source.');
  }
  assertRoutes(catalog.routes, state);
}

export async function readSource(client, state) {
  const route = `/v1/catalog/scan/sources/${uuid(state.sourceId)}`;
  const [detail, bindings, catalog, health] = await Promise.all([
    client.request(route), client.request(`${route}/bindings`),
    client.request(`${route}/active-chains`), client.request(`${route}/health`),
  ]);
  assertSource(detail.data, bindings.data, catalog.data, state);
  return { detail: detail.data, bindings: bindings.data, catalog: catalog.data, health: health.data };
}

export function readDaemon(directory) {
  try {
    return { daemon: JSON.parse(readFileSync(`${directory}/scan.state.json`, 'utf8')),
      sync: JSON.parse(readFileSync(`${directory}/scan.sync.json`, 'utf8')),
      cache: JSON.parse(readFileSync(`${directory}/scan.catalog-cache.json`, 'utf8')) };
  } catch { throw new Error('Scan has not written its readiness snapshot yet. Retry shortly.'); }
}

export function assertCoverage({ daemon, sync }, health, now = Date.now()) {
  const fresh = (value, age) => Number.isFinite(Date.parse(value)) && now - Date.parse(value) >= -5000 && now - Date.parse(value) <= age;
  if (daemon.phase !== 'realtime' || !fresh(daemon.written_at, 30000) ||
      daemon.coverage?.total !== 3 || daemon.coverage.running !== 3 || daemon.coverage.failed !== 0 ||
      !Array.isArray(daemon.sources) || daemon.sources.length !== 3 ||
      new Set(daemon.sources.map((source) => source.name)).size !== 3 ||
      daemon.sources.some((source) => source.kind !== 'file' || source.status !== 'running' ||
        !/^file:\/var\/log\/clutta-playground\/(api|worker|scheduler)\.log$/.test(source.name)) ||
      !fresh(sync.heartbeat_accepted_at, 90000) || (sync.heartbeat_consecutive_errors ?? 0) !== 0 ||
      (sync.pulse_consecutive_errors ?? 0) !== 0 || health?.healthy !== true || health.state !== 'active') {
    throw new Error('Observation is not ready. Check the lab files, Scan coverage, and accepted heartbeat; this is not a business incident.');
  }
}

export function assertDefinition(definition, state) {
  if (definition?.origin !== 'learned' || definition.scope?.workspace_id !== state.workspaceId ||
      definition.scope?.project_id !== state.projectId || definition.correlation_recipe?.join_key !== 'payment_id' ||
      !Array.isArray(definition.steps) || definition.steps.length !== 3 || definition.steps.some((step) => step.required !== true)) {
    throw new Error('The proposed flow is not the three-step payment journey. Inspect its evidence in the UI; do not activate it just to pass the demo.');
  }
  const ordered = [...definition.steps].sort((left, right) => left.position - right.position);
  if (new Set(ordered.map((step) => step.id)).size !== 3 || ordered.some((step, index) => !step.id || !Number.isInteger(step.position) ||
      (index > 0 && step.position <= ordered[index - 1].position))) throw new Error('The three steps do not have unique ordered identities.');
  for (const step of definition.steps) {
    if (!step.patterns?.length || step.patterns.some((pattern) => !/[a-zA-Z]{2}/.test(pattern.expression?.replaceAll('{}', '') ?? ''))) {
      throw new Error('A required step has no meaningful literal anchor. Preserve this failing definition for a focused product fix.');
    }
  }
  if (!Number.isFinite(definition.deadline_ms) || definition.deadline_ms < 1000 || definition.deadline_ms > 120000) {
    throw new Error('The learned deadline is outside this interactive demo\'s 1-120 second safety budget. Do not override it in a lab script.');
  }
  return definition;
}

export function loadedActivation(snapshot, catalog, proposalId, state) {
  const active = catalog.active_chains?.find((chain) => chain.proposal_id === proposalId);
  if (!active) return null;
  assertDefinition(active.definition, state);
  if (!active.approval_id || !active.definition_fingerprint || !active.catalog_generation ||
      !active.readiness || active.readiness.blockers?.length ||
      ['patterns_executable', 'scope_ready', 'source_coverage_ready', 'replay_ready', 'correlation_ready', 'outcome_rules_unambiguous']
        .some((field) => active.readiness[field] !== true)) throw new Error('The activated definition is not ready for monitored evidence.');
  const cache = snapshot.cache;
  const cached = cache?.active_catalog;
  if (cache?.workspace_id !== state.workspaceId || cached?.workspace_id !== state.workspaceId || cached?.source_id !== state.sourceId ||
      cached.snapshot_fingerprint !== catalog.snapshot_fingerprint || cached.catalog_generation !== catalog.catalog_generation) return null;
  const loaded = cached.active_chains?.find((chain) => chain.proposal_id === proposalId);
  if (!loaded || loaded.approval_id !== active.approval_id || loaded.definition_fingerprint !== active.definition_fingerprint ||
      loaded.definition.id !== active.definition.id || loaded.definition.version !== active.definition.version ||
      loaded.catalog_generation !== active.catalog_generation) return null;
  return active;
}

export function evidencePayment(evidence) {
  try { return JSON.parse(evidence?.raw ?? '').payment_id; } catch { return null; }
}

export function ownedEvidenceSource(source, state) {
  return ['api', 'worker', 'scheduler'].some((role) => source === `${state.agentName}/file//var/log/clutta-playground/${role}.log`);
}

export function localInstance(pulses, paymentId, active, state) {
  const found = pulses.filter((pulse) => pulse.workspace_id === state.workspaceId && pulse.chain_id === active.definition.id &&
    pulse.installation_id === state.installationId &&
    pulse.chain_version === active.definition.version && pulse.match_result?.authoritative === true &&
    pulse.match_result.catalog_generation === active.catalog_generation && ownedEvidenceSource(pulse.source_id, state) &&
    pulse.match_result.source_id === pulse.source_id && pulse.match_result.evidence?.source_id === pulse.source_id &&
    evidencePayment(pulse.match_result.evidence) === paymentId);
  const identities = new Set(found.map((pulse) => pulse.instance_id));
  if (identities.size > 1) throw new Error('One payment split into multiple monitored instances. The demo gate remains red.');
  return found[0]?.instance_id ?? null;
}

export function assertInstance(instance, paymentId, active, state, { complete = true } = {}) {
  if (instance.workspace_id !== state.workspaceId || instance.registered_source_id !== state.sourceId ||
      instance.installation_id !== state.installationId || instance.chain_id !== active.definition.id ||
      instance.chain_version !== active.definition.version) throw new Error('Monitored instance identity or tenant differs from this run.');
  assertRoutes(instance.routes, state);
  const lineage = instance.lineage;
  if (lineage?.availability !== 'available' || !lineage.definition_available || !lineage.observations_complete || !lineage.violations_complete ||
      lineage.definition_fingerprint !== active.definition_fingerprint || lineage.catalog_generation !== active.catalog_generation) {
    throw new Error('Clutta has not retained complete authoritative lineage for this run.');
  }
  if (!lineage.observations?.some((observation) => evidencePayment(observation.match?.evidence) === paymentId)) {
    throw new Error('The cited records do not identify the payment submitted by this lab.');
  }
  for (const observation of lineage.observations) {
    if (observation.registered_source_id !== state.sourceId || observation.match?.authoritative !== true ||
        observation.match.catalog_generation !== active.catalog_generation || observation.source_id !== observation.match.source_id ||
        !ownedEvidenceSource(observation.match.source_id, state) ||
        observation.match.evidence?.source_id !== observation.match.source_id || evidencePayment(observation.match.evidence) !== paymentId ||
        !observation.match.evidence?.fingerprint) throw new Error('Run contains evidence without the expected active authority or payment identity.');
    assertRoutes(observation.routes, state);
  }
  if (complete && (instance.state !== 'completed' || active.definition.steps.some((step) => !instance.signatures_fired.includes(step.id) ||
      !lineage.observations.some((observation) => observation.signature_id === step.id && observation.match.signature_id === step.id)) ||
      lineage.violations.length !== 0)) throw new Error('Healthy work did not produce a complete, violation-free monitored run. Do not inject a fault yet.');
  if (complete) {
    const expected = [
      ['api', 'payment-api', 'payment.accepted'],
      ['worker', 'payment-worker', 'notification.queued'],
      ['scheduler', 'notification-scheduler', 'notification.delivered'],
    ];
    const ordered = [...active.definition.steps].sort((left, right) => left.position - right.position);
    for (const [index, step] of ordered.entries()) {
      const [role, service, event] = expected[index];
      const provesStep = lineage.observations.some((observation) => {
        if (observation.signature_id !== step.id || observation.match.signature_id !== step.id ||
            observation.source_id !== `${state.agentName}/file//var/log/clutta-playground/${role}.log`) return false;
        try {
          const record = JSON.parse(observation.match.evidence.raw);
          return record.service === service && record.event === event;
        } catch { return false; }
      });
      if (!provesStep) throw new Error('Healthy lineage does not prove accepted, queued, then scheduler-delivered business steps. Do not inject a fault yet.');
    }
  }
  return instance;
}

export function assertCaseMember(member, instanceId, active, state, paymentId) {
  uuid(paymentId, 'Fault payment ID');
  const { instance, violation } = member;
  const finalStep = [...active.definition.steps].sort((left, right) => left.position - right.position).at(-1);
  if (instance?.instance_id !== instanceId || instance.registered_source_id !== state.sourceId ||
      instance.workspace_id !== state.workspaceId || instance.installation_id !== state.installationId || instance.chain_id !== active.definition.id ||
      instance.chain_version !== active.definition.version || violation?.instance_id !== instanceId ||
      violation.workspace_id !== state.workspaceId || violation.project_id !== state.projectId ||
      violation.chain_id !== active.definition.id || violation.chain_version !== active.definition.version ||
      violation.catalog_generation !== active.catalog_generation || violation.kind !== 'missing_step' ||
      !violation.installation_ids?.includes(state.installationId) ||
      violation.source_health !== 'ready' || violation.expected_signature_id !== finalStep.id ||
      !(violation.expected_at_ms > 0 && violation.occurred_at_ms >= violation.expected_at_ms) ||
      !violation.evidence?.length || violation.evidence.some((record) => !ownedEvidenceSource(record.source_id, state) || !record.fingerprint ||
        evidencePayment(record) !== paymentId)) {
    throw new Error('The Case File does not prove this payment\'s missing final step with ready-source cited evidence.');
  }
  assertRoutes(instance.routes, state);
  return member;
}
