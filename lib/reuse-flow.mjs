import { assertDefinition, assertRoutes, loadedActivation, uuid } from './cloud.mjs';
import { businessEvents } from './scenario.mjs';

function portableSelector(selector = {}, component) {
  return !selector.identifier_prefix && !selector.source_ids?.length &&
    (!selector.source_class || selector.source_class === 'file') &&
    (!selector.components?.length || (selector.components.length === 1 && selector.components[0] === component));
}

// Reusing a definition does not recover any lost collector or workload state.
export function reuseIntent(intent, state) {
  if (intent.workspaceId !== state.workspaceId || intent.projectId !== state.projectId ||
      intent.scenario !== state.scenario) throw new Error('Saved flow reuse belongs to another workspace, project or scenario.');
  uuid(intent.proposalId, 'Approved proposal ID');
  if (state.proposalId && state.proposalId !== intent.proposalId) throw new Error('An existing session already identifies another proposal. It was not replaced.');
  return intent;
}

export function reusableFlow(catalog, proposalId, state) {
  uuid(proposalId, 'Approved proposal ID');
  if (catalog.workspace_id !== state.workspaceId || catalog.source_id !== state.sourceId || catalog.route_mode !== 'bindings' ||
      !catalog.snapshot_fingerprint || !catalog.catalog_generation) {
    throw new Error('Flow reuse requires the selected source-bound catalog.');
  }
  assertRoutes(catalog.routes, state);
  const matches = catalog.active_chains?.filter((row) => row.proposal_id === proposalId) ?? [];
  if (matches.length !== 1) throw new Error('The chosen proposal is not uniquely active for this source. No learning or approval fallback was attempted.');
  const active = matches[0];
  assertDefinition(active.definition, state);
  for (const scope of [active.definition.scope, active.activation_scope]) {
    if (scope?.kind !== 'project' || scope.workspace_id !== state.workspaceId || scope.project_id !== state.projectId) {
      throw new Error('The approved flow must be scoped to this exact workspace and project.');
    }
  }
  const steps = [...active.definition.steps].sort((a, b) => a.position - b.position);
  const components = ['payment-api', 'payment-worker', 'notification-scheduler'];
  const events = businessEvents(state.scenario);
  for (const [index, step] of steps.entries()) {
    const predecessors = step.predecessors ?? [];
    const patterns = step.patterns;
    const extractors = active.definition.correlation_recipe.extractors?.filter((row) => row.signature_id === step.id);
    if (predecessors.length !== (index ? 1 : 0) || (index && predecessors[0] !== steps[index - 1].id) ||
        patterns.length !== 1 || patterns[0].kind !== 'field_predicate' || patterns[0].expression !== `json.event=${events[index]}` ||
        patterns[0].source_selector?.components?.length !== 1 || patterns[0].source_selector.components[0] !== components[index] ||
        !portableSelector(patterns[0].source_selector, components[index]) ||
        extractors?.length !== 1 || extractors[0].paths?.length !== 1 || extractors[0].paths[0] !== 'payment_id' ||
        extractors[0].capture || !portableSelector(extractors[0].source_selector, components[index])) {
      throw new Error('The approved flow does not exactly match this scenario, order and payment_id grouping. No traffic was generated.');
    }
  }
  // Reuse the existing authority/readiness checks against the current server catalog.
  loadedActivation({ cache: { workspace_id: state.workspaceId, active_catalog: catalog } }, catalog, proposalId, state);
  return active;
}

export function loadedReusableFlow(snapshot, catalog, proposalId, state) {
  reusableFlow(catalog, proposalId, state);
  const active = loadedActivation(snapshot, catalog, proposalId, state);
  if (!active) return null;
  reusableFlow(snapshot.cache.active_catalog, proposalId, state);
  return active;
}
