import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';

export const RELEASES_URL = 'https://api.github.com/repos/sefastech/clutta-cli-releases/releases/latest';
export const HELM_INDEX_URL = 'https://sefastech.github.io/clutta-helm-charts/index.yaml';
export const CLI_DOWNLOAD_TIMEOUT_MS = 300_000;
export const METADATA_DOWNLOAD_TIMEOUT_MS = 60_000;
const ASSET_BASE = 'https://github.com/sefastech/clutta-cli-releases/releases/download/';
const CHART_BASE = 'https://sefastech.github.io/clutta-helm-charts/charts/';
const REGISTRY_BASE = 'https://registry-1.docker.io/v2/sefastech/clutta-scan';
const TOKEN_URL = 'https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Asefastech%2Fclutta-scan%3Apull';
const REPOSITORY_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INDEX_TYPES = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
const MANIFEST_TYPES = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
const CONFIG_TYPES = new Set(['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json']);
const ACCEPT_MANIFEST = [...INDEX_TYPES, ...MANIFEST_TYPES].join(', ');
const execFileAsync = promisify(execFile);

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(`Clutta runtime: ${message}`); };

export function runtimePlatform(platform, arch) {
  if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) {
    fail('supported runtime platforms are Linux x64 and Linux arm64');
  }
  return { os: 'linux', architecture: arch === 'x64' ? 'amd64' : 'arm64' };
}

function parseJSON(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail(`${label} is not valid JSON`); }
}

function parseYAML(text, label) {
  try {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length > 0) fail(`${label} is not valid YAML`);
    return document.toJS({ maxAliasCount: 0 });
  } catch { fail(`${label} is not valid YAML`); }
}

function digestOf(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`${label} requires a SHA256 digest`);
  return value;
}

export function validateStableRelease(payload, assetName) {
  if (!payload || !STABLE_TAG.test(payload.tag_name ?? '') || payload.draft !== false || payload.prerelease !== false) {
    fail('latest release is not an official stable version');
  }
  if (!Array.isArray(payload.assets)) fail('latest release has no artifact list');
  const required = [assetName, 'sha256sums.txt', 'provenance.json'];
  const assets = {};
  for (const name of required) {
    const matches = payload.assets.filter((asset) => asset?.name === name);
    if (matches.length !== 1) fail(`release requires exactly one ${name} artifact`);
    const asset = matches[0];
    if (asset.browser_download_url !== `${ASSET_BASE}${payload.tag_name}/${name}`) {
      fail(`${name} does not use the trusted official artifact URL`);
    }
    digestOf(asset.digest, `${name} metadata`);
    const maximum = name === assetName ? 128 * 1024 * 1024 : 2 * 1024 * 1024;
    if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maximum) fail(`${name} has an invalid artifact size`);
    assets[name] = asset;
  }
  return { tag: payload.tag_name, assets };
}

export function parseChecksums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/).filter((value) => value.trim() !== '')) {
    const match = /^([0-9a-f]{64})\s{2}([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || sums.has(match[2])) fail('checksum list contains malformed or duplicate entries');
    sums.set(match[2], match[1]);
  }
  return sums;
}

export function validateProvenance(payload, tag, assetName, checksum) {
  if (!payload || payload.schema !== 'clutta.release.provenance/v1' || payload.product !== 'clutta-incident' ||
      payload.version !== tag || payload.git_tag !== `clutta-incident-${tag}` || payload.source_clean !== true ||
      !/^[0-9a-f]{40}$/.test(payload.git_revision ?? '') || !Array.isArray(payload.artifacts)) {
    fail('release provenance does not identify a clean matching official source');
  }
  const artifacts = payload.artifacts.filter((artifact) => artifact?.name === assetName);
  if (artifacts.length !== 1 || artifacts[0].sha256 !== checksum || !SHA256.test(checksum ?? '')) {
    fail('release provenance and platform checksum disagree');
  }
  return payload.git_revision;
}

export function validateELF(bytes, architecture) {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== (architecture === 'amd64' ? 62 : 183)) {
    fail('CLI artifact is not an ELF binary for the selected Linux architecture');
  }
}

export function selectChart(text, tag) {
  const index = parseYAML(text, 'Helm index');
  const entries = index?.entries?.['clutta-scan'];
  if (!Array.isArray(entries)) fail('Helm index has no clutta-scan entries');
  const candidates = entries.filter((entry) => entry?.appVersion === tag && typeof entry.version === 'string' && VERSION.test(entry.version));
  if (candidates.length === 0) fail(`no published Helm chart matches ${tag}`);
  candidates.sort((left, right) => {
    const a = left.version.split('.').map(BigInt);
    const b = right.version.split('.').map(BigInt);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? -1 : 1;
    }
    return 0;
  });
  const selected = candidates[0];
  if (candidates.filter((entry) => entry.version === selected.version).length !== 1) fail('Helm index has duplicate matching chart versions');
  if (selected.name !== 'clutta-scan' || !SHA256.test(selected.digest ?? '') || !Array.isArray(selected.urls) ||
      selected.urls.length !== 1 || selected.urls[0] !== `${CHART_BASE}clutta-scan-${selected.version}.tgz`) {
    fail('matching Helm chart has invalid identity, digest, or trusted URL');
  }
  return { version: selected.version, digest: selected.digest, url: selected.urls[0] };
}

async function request(fetchImpl, url, { label, maximum = 2 * 1024 * 1024, headers = {}, timeoutMs = METADATA_DOWNLOAD_TIMEOUT_MS } = {}) {
  let response;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    response = await fetchImpl(url, {
      cache: 'no-store', headers, signal,
    });
  } catch {
    if (signal.aborted) fail(`${label} exceeded its ${timeoutMs / 1000}s download deadline; latest runtime was not refreshed`);
    fail(`${label} could not be fetched; latest runtime was not refreshed`);
  }
  if (!response.ok) fail(`${label} request failed with HTTP ${response.status}; latest runtime was not refreshed`);
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) fail(`${label} exceeds its download limit`);
  const chunks = [];
  let total = 0;
  try {
    if (!response.body) fail(`${label} returned an empty response`);
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maximum) fail(`${label} exceeds its download limit`);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error?.message?.startsWith('Clutta runtime:')) throw error;
    if (signal.aborted) fail(`${label} exceeded its ${timeoutMs / 1000}s download deadline; latest runtime was not refreshed`);
    fail(`${label} download did not finish; latest runtime was not refreshed`);
  }
  if (total === 0) fail(`${label} returned an empty response`);
  return { bytes: Buffer.concat(chunks), headers: response.headers };
}

async function artifact(fetchImpl, asset, timeoutMs = METADATA_DOWNLOAD_TIMEOUT_MS) {
  const { bytes } = await request(fetchImpl, asset.browser_download_url, { label: asset.name, maximum: asset.size, timeoutMs });
  if (bytes.length !== asset.size || `sha256:${sha256(bytes)}` !== asset.digest) fail(`${asset.name} does not match GitHub artifact metadata`);
  return bytes;
}

function verifyRegistryObject(result, expectedDigest, label, expectedSize) {
  const digest = `sha256:${sha256(result.bytes)}`;
  if (expectedDigest && digest !== digestOf(expectedDigest, label)) fail(`${label} content digest mismatch`);
  const declared = result.headers.get('docker-content-digest');
  if (declared !== null && declared !== digest) fail(`${label} registry digest mismatch`);
  if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize !== result.bytes.length)) fail(`${label} manifest size mismatch`);
  return digest;
}

async function resolveScanImage(fetchImpl, tag, sourceRevision, architecture) {
  const tokenResponse = await request(fetchImpl, TOKEN_URL, { label: 'public Scan registry token' });
  const tokenPayload = parseJSON(tokenResponse.bytes, 'public Scan registry token');
  const token = tokenPayload.token ?? tokenPayload.access_token;
  if (typeof token !== 'string' || token.length === 0 || /[\r\n]/.test(token)) fail('public Scan registry did not provide a pull token');
  const headers = { Authorization: `Bearer ${token}`, Accept: ACCEPT_MANIFEST };
  const root = await request(fetchImpl, `${REGISTRY_BASE}/manifests/${tag}`, { label: 'Scan release manifest', headers });
  const imageDigest = verifyRegistryObject(root, undefined, 'Scan release manifest');
  let manifest = parseJSON(root.bytes, 'Scan release manifest');
  if (manifest?.schemaVersion !== 2) fail('Scan release has an unsupported manifest schema');
  let platformDigest = imageDigest;
  if (INDEX_TYPES.has(manifest.mediaType)) {
    if (!Array.isArray(manifest.manifests)) fail('Scan release index has no platform manifests');
    const matches = manifest.manifests.filter((entry) => entry?.platform?.os === 'linux' && entry.platform.architecture === architecture);
    if (matches.length !== 1) fail('Scan release requires exactly one matching Linux platform');
    const descriptor = matches[0];
    digestOf(descriptor.digest, 'Scan platform descriptor');
    if (!MANIFEST_TYPES.has(descriptor.mediaType)) fail('Scan platform descriptor has an unsupported media type');
    const result = await request(fetchImpl, `${REGISTRY_BASE}/manifests/${descriptor.digest}`, { label: 'Scan platform manifest', headers });
    platformDigest = verifyRegistryObject(result, descriptor.digest, 'Scan platform manifest', descriptor.size);
    manifest = parseJSON(result.bytes, 'Scan platform manifest');
  }
  if (manifest?.schemaVersion !== 2 || !MANIFEST_TYPES.has(manifest.mediaType)) fail('Scan platform has an unsupported manifest schema or media type');
  const configDescriptor = manifest.config;
  digestOf(configDescriptor?.digest, 'Scan image configuration');
  if (!CONFIG_TYPES.has(configDescriptor.mediaType)) fail('Scan image configuration has an unsupported media type');
  const configResult = await request(fetchImpl, `${REGISTRY_BASE}/blobs/${configDescriptor.digest}`, { label: 'Scan image configuration', headers });
  verifyRegistryObject(configResult, configDescriptor.digest, 'Scan image configuration', configDescriptor.size);
  const config = parseJSON(configResult.bytes, 'Scan image configuration');
  const labels = config?.config?.Labels;
  if (config?.os !== 'linux' || config.architecture !== architecture ||
      labels?.['org.opencontainers.image.version'] !== tag ||
      labels?.['org.opencontainers.image.revision'] !== sourceRevision ||
      labels?.['org.opencontainers.image.source'] !== 'https://github.com/sefastech/clutta' ||
      config.config.User !== '65532:65532') {
    fail('Scan image platform, non-root user, version, or source labels do not match the CLI release');
  }
  return { image: `sefastech/clutta-scan@${imageDigest}`, imageDigest, platformDigest };
}

function within(parent, child) {
  const relation = relative(parent, child);
  return relation === '' || (relation !== '..' && !relation.startsWith('../') && !isAbsolute(relation));
}

export function validatePrivateDirectory(metadata, label, uid = process.getuid()) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(`${label} must be a real directory, not a symbolic link`);
  if (metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
    fail(`${label} must be owned by the current user with no group or world permissions`);
  }
}

async function outputDirectory(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) === '/') fail('provide an absolute lab-owned runtime directory outside the checkout');
  const requested = resolve(directory);
  if (within(REPOSITORY_DIRECTORY, requested)) fail('runtime artifacts must stay outside the checkout');
  // Check existing ancestors before mkdir so a redirected parent cannot receive new files.
  let ancestor = requested;
  for (;;) {
    try {
      const metadata = await lstat(ancestor);
      if (metadata.isSymbolicLink() || await realpath(ancestor) !== ancestor) {
        fail('runtime directory must not resolve through symbolic links');
      }
      if (!metadata.isDirectory()) fail('runtime directory has a non-directory ancestor');
      if (ancestor === requested) validatePrivateDirectory(metadata, 'runtime directory');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const actual = await realpath(requested);
  if (actual !== requested) fail('runtime directory must not resolve through symbolic links');
  validatePrivateDirectory(await lstat(requested), 'runtime directory');
  if (within(await realpath(REPOSITORY_DIRECTORY), actual)) fail('runtime directory resolves inside the checkout');
  return actual;
}

/** Resolve a complete stable release on every call. A failed refresh never publishes a partial receipt. */
export async function installRuntime({ directory, fetchImpl = fetch, platform = process.platform, arch = process.arch, onProgress = () => {} }) {
  const target = runtimePlatform(platform, arch);
  if (typeof onProgress !== 'function') fail('onProgress must be a function');
  const assetName = `clutta-${target.os}-${target.architecture}`;
  await onProgress('Checking the latest official stable release');
  const releaseResponse = await request(fetchImpl, RELEASES_URL, { label: 'latest stable release', headers: { Accept: 'application/vnd.github+json' } });
  const release = validateStableRelease(parseJSON(releaseResponse.bytes, 'latest stable release'), assetName);
  await onProgress(`Downloading ${release.tag} CLI and its verification metadata`);
  const [cli, checksumBytes, provenanceBytes, chartIndex] = await Promise.all([
    artifact(fetchImpl, release.assets[assetName], CLI_DOWNLOAD_TIMEOUT_MS),
    artifact(fetchImpl, release.assets['sha256sums.txt']),
    artifact(fetchImpl, release.assets['provenance.json']),
    request(fetchImpl, HELM_INDEX_URL, { label: 'published Helm index', maximum: 8 * 1024 * 1024 }),
  ]);
  await onProgress('Verifying CLI checksum, architecture, and clean source provenance');
  const checksum = parseChecksums(checksumBytes.toString('utf8')).get(assetName);
  if (checksum !== sha256(cli)) fail('CLI artifact and published checksum disagree');
  validateELF(cli, target.architecture);
  const sourceRevision = validateProvenance(parseJSON(provenanceBytes, 'release provenance'), release.tag, assetName, checksum);
  const chart = selectChart(chartIndex.bytes.toString('utf8'), release.tag);
  await onProgress('Verifying the matching immutable Scan image and Helm chart');
  const [scan, chartResult] = await Promise.all([
    resolveScanImage(fetchImpl, release.tag, sourceRevision, target.architecture),
    request(fetchImpl, chart.url, { label: 'matching Helm chart', maximum: 8 * 1024 * 1024 }),
  ]);
  if (sha256(chartResult.bytes) !== chart.digest) fail('Helm chart package checksum mismatch');
  const runtimeDirectory = await outputDirectory(directory);
  const bundles = join(runtimeDirectory, 'versions');
  await mkdir(bundles, { recursive: true, mode: 0o700 });
  validatePrivateDirectory(await lstat(bundles), 'runtime versions directory');
  if (await realpath(bundles) !== bundles) fail('runtime versions directory must not be a symbolic link');
  const stage = await mkdtemp(join(bundles, '.staging-'));
  try {
    await onProgress('Writing verified artifacts and publishing the runtime receipt');
    const chartFilename = `clutta-scan-${chart.version}.tgz`;
    await writeFile(join(stage, chartFilename), chartResult.bytes, { mode: 0o600, flag: 'wx' });
    let chartYAML;
    try {
      const result = await execFileAsync('tar', ['-xzOf', join(stage, chartFilename), 'clutta-scan/Chart.yaml'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
      chartYAML = result.stdout;
    } catch { fail('Helm chart metadata could not be read with tar'); }
    const chartMetadata = parseYAML(chartYAML, 'Helm Chart.yaml');
    if (chartMetadata?.name !== 'clutta-scan' || chartMetadata.version !== chart.version || chartMetadata.appVersion !== release.tag || chartMetadata.apiVersion !== 'v2') {
      fail('Helm Chart.yaml does not match the selected chart and CLI release');
    }
    await writeFile(join(stage, 'clutta'), cli, { mode: 0o755, flag: 'wx' });
    await chmod(join(stage, 'clutta'), 0o755);
    await writeFile(join(stage, 'sha256sums.txt'), checksumBytes, { mode: 0o600, flag: 'wx' });
    await writeFile(join(stage, 'provenance.json'), provenanceBytes, { mode: 0o600, flag: 'wx' });
    const bundleDirectory = join(bundles, `${release.tag}-${sourceRevision.slice(0, 12)}-${randomUUID()}`);
    const receiptPath = join(runtimeDirectory, 'current.json');
    const receipt = {
      schema: 'clutta.playground.runtime/v1', tag: release.tag, sourceRevision,
      scanImage: scan.image, scanImageDigest: scan.imageDigest, scanPlatformDigest: scan.platformDigest,
      cliPath: join(bundleDirectory, 'clutta'), cliSha256: checksum,
      chartPath: join(bundleDirectory, chartFilename), chartVersion: chart.version, chartSha256: chart.digest,
      provenancePath: join(bundleDirectory, 'provenance.json'), receiptPath, directory: runtimeDirectory,
      platform: target.os, architecture: target.architecture, resolvedAt: new Date().toISOString(),
    };
    await writeFile(join(stage, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(stage, bundleDirectory);
    const receiptTemporary = join(runtimeDirectory, `.current-${randomUUID()}.tmp`);
    await writeFile(receiptTemporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(receiptTemporary, receiptPath);
    return receipt;
  } catch (error) {
    // Retain failed staging and temporary receipts for the first-failure investigation.
    // An incomplete bundle is never made current and no older bundle is removed.
    throw new Error(`${error.message}; artifacts retained in ${runtimeDirectory}`, { cause: error });
  }
}
