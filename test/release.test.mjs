import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  CLI_DOWNLOAD_TIMEOUT_MS, HELM_INDEX_URL, METADATA_DOWNLOAD_TIMEOUT_MS, RELEASES_URL,
  installRuntime, parseChecksums, runtimePlatform,
  selectChart, sha256, validatePrivateDirectory, validateStableRelease,
} from '../lib/release.mjs';

const assetBase = 'https://github.com/sefastech/clutta-cli-releases/releases/download/';
const registryBase = 'https://registry-1.docker.io/v2/sefastech/clutta-scan';
const chartBase = 'https://sefastech.github.io/clutta-helm-charts/charts/';
const tokenURL = 'https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Asefastech%2Fclutta-scan%3Apull';
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const indexType = 'application/vnd.oci.image.index.v1+json';
const repository = fileURLToPath(new URL('../', import.meta.url));
const jsonBytes = (value) => Buffer.from(JSON.stringify(value));
const digest = (bytes) => `sha256:${sha256(bytes)}`;

// A real tar/gzip package lets tests exercise the same metadata reader as published charts.
function chartArchive(chartYAML) {
  const contents = Buffer.from(chartYAML);
  const header = Buffer.alloc(512);
  header.write('clutta-scan/Chart.yaml', 0, 100, 'ascii');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${contents.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - contents.length % 512) % 512);
  return gzipSync(Buffer.concat([header, contents, padding, Buffer.alloc(1024)]));
}

function fixture(options = {}) {
  const tag = options.tag ?? 'v0.2.20';
  const architecture = options.architecture ?? 'amd64';
  const revision = '74109140f06977ee6dd3b85c52847891bb74f60f';
  const chartVersion = '0.3.19';
  const assetName = `clutta-linux-${architecture}`;
  const cli = Buffer.alloc(128, 0);
  cli.write('7f454c46', 0, 'hex');
  cli[4] = 2;
  cli[5] = 1;
  cli.writeUInt16LE((options.elfArchitecture ?? architecture) === 'amd64' ? 62 : 183, 18);
  const checksum = sha256(cli);
  const sums = Buffer.from(`${options.checksum ?? checksum}  ${assetName}\n`);
  const provenance = {
    schema: 'clutta.release.provenance/v1', product: 'clutta-incident', version: tag,
    git_tag: `clutta-incident-${tag}`, git_revision: revision, source_clean: true,
    build_time: '2026-10-02T14:14:30Z', go_version: 'go version go1.26.6 linux/amd64',
    artifacts: [{ name: assetName, sha256: checksum }], ...options.provenance,
  };
  const artifacts = new Map([[assetName, cli], ['sha256sums.txt', sums], ['provenance.json', jsonBytes(provenance)]]);
  const release = {
    tag_name: tag, draft: false, prerelease: false,
    assets: [...artifacts].map(([name, bytes], index) => ({
      id: 304520100 + index, name, size: bytes.length, digest: digest(bytes),
      browser_download_url: `${assetBase}${tag}/${name}`,
    })),
  };
  options.changeRelease?.(release);
  const chart = options.chartBytes ?? chartArchive(options.chartYAML ??
    `apiVersion: v2\nname: clutta-scan\nversion: ${chartVersion}\nappVersion: ${tag}\n`);
  const chartEntry = {
    name: 'clutta-scan', version: chartVersion, appVersion: tag, digest: sha256(chart),
    urls: [`${chartBase}clutta-scan-${chartVersion}.tgz`], ...options.chartEntry,
  };
  // The newest chart is deliberately for a different application release.
  const index = jsonBytes({ apiVersion: 'v1', entries: { 'clutta-scan': [
    { ...chartEntry, version: '0.3.20', appVersion: 'v0.2.21' }, chartEntry,
  ] } });
  const config = {
    architecture, os: 'linux', config: {
      User: '65532:65532', Labels: {
        'org.opencontainers.image.version': tag,
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.source': 'https://github.com/sefastech/clutta',
      },
    },
  };
  options.changeConfig?.(config);
  const configBytes = jsonBytes(config);
  const manifestBytes = jsonBytes({
    schemaVersion: 2, mediaType: manifestType,
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', size: configBytes.length, digest: digest(configBytes) },
    layers: [],
  });
  const imageIndex = {
    schemaVersion: 2, mediaType: indexType, manifests: [
      { mediaType: manifestType, size: manifestBytes.length, digest: digest(manifestBytes), platform: { os: 'linux', architecture } },
      { mediaType: manifestType, size: 123, digest: `sha256:${'a'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' } },
    ],
  };
  options.changeImageIndex?.(imageIndex);
  const imageIndexBytes = jsonBytes(imageIndex);
  const routes = new Map([
    [RELEASES_URL, { bytes: jsonBytes(release) }],
    [HELM_INDEX_URL, { bytes: index }],
    [`${chartBase}clutta-scan-${chartVersion}.tgz`, { bytes: chart }],
    [tokenURL, { bytes: jsonBytes({ token: 'public-anonymous-pull-token' }) }],
    [`${registryBase}/manifests/${tag}`, { bytes: imageIndexBytes, headers: { 'docker-content-digest': options.registryDigest ?? digest(imageIndexBytes) } }],
    [`${registryBase}/manifests/${digest(manifestBytes)}`, { bytes: manifestBytes, headers: { 'docker-content-digest': digest(manifestBytes) } }],
    [`${registryBase}/blobs/${digest(configBytes)}`, { bytes: configBytes }],
    ...[...artifacts].map(([name, bytes]) => [`${assetBase}${tag}/${name}`, { bytes }]),
  ]);
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    const route = routes.get(url);
    if (!route) throw new Error(`Unexpected test URL: ${url}`);
    if (route.error) throw route.error;
    return new Response(route.bytes, { status: route.status ?? 200, headers: route.headers });
  };
  return { routes, calls, fetchImpl, tag, revision, cli, chart, checksum, architecture, assetName,
    expectedImage: `sefastech/clutta-scan@${digest(imageIndexBytes)}`, release };
}

async function directory(label = 'install-') {
  const root = join(process.env.CLUTTA_PLAYGROUND_DATA_ROOT ?? join(homedir(), 'sanitized-cases/clutta-playground'), 'release-tests');
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, label));
}

async function install(fixture, destination) {
  return installRuntime({ directory: destination ?? await directory(), fetchImpl: fixture.fetchImpl,
    platform: 'linux', arch: fixture.architecture === 'amd64' ? 'x64' : 'arm64' });
}

test('installs a coherent official CLI, immutable Scan image and matching chart with protected receipt', async () => {
  const data = fixture();
  const receipt = await install(data);
  assert.equal(receipt.tag, data.tag);
  assert.equal(receipt.sourceRevision, data.revision);
  assert.equal(receipt.scanImage, data.expectedImage);
  assert.equal(receipt.chartVersion, '0.3.19');
  assert.deepEqual(await readFile(receipt.cliPath), data.cli);
  assert.deepEqual(await readFile(receipt.chartPath), data.chart);
  assert.equal((await stat(receipt.cliPath)).mode & 0o777, 0o755);
  assert.equal((await stat(receipt.receiptPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(receipt.receiptPath, 'utf8')), receipt);
  assert.deepEqual(JSON.parse(await readFile(join(receipt.cliPath, '../receipt.json'), 'utf8')), receipt);
  assert.equal(JSON.stringify(receipt).includes('public-anonymous-pull-token'), false);
  assert.ok(data.calls.every(({ request }) => request.cache === 'no-store'));
  assert.equal(data.calls.filter(({ url }) => url === RELEASES_URL).length, 1);
  assert.ok(data.calls.some(({ url, request }) => url.includes('/blobs/') && request.headers.Authorization === 'Bearer public-anonymous-pull-token'));
  assert.ok((await readdir(join(receipt.directory, 'versions'))).every((name) => !name.startsWith('.staging-')));
});

test('Linux arm64 is verified independently instead of accepting the amd64 artifact', async () => {
  const data = fixture({ architecture: 'arm64' });
  const receipt = await install(data);
  assert.equal(receipt.architecture, 'arm64');
  assert.equal(receipt.scanImage, data.expectedImage);
  assert.deepEqual(await readFile(receipt.cliPath), data.cli);
});

test('the large CLI has a bounded five-minute deadline while metadata remains one minute', async () => {
  const data = fixture();
  const deadlines = new WeakMap();
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    const signal = originalTimeout(milliseconds);
    deadlines.set(signal, milliseconds);
    return signal;
  };
  const phases = [];
  try {
    await installRuntime({ directory: await directory(), platform: 'linux', arch: 'x64',
      fetchImpl: data.fetchImpl, onProgress: (message) => phases.push(message) });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  assert.equal(CLI_DOWNLOAD_TIMEOUT_MS, 300_000);
  assert.equal(METADATA_DOWNLOAD_TIMEOUT_MS, 60_000);
  for (const { url, request } of data.calls) {
    assert.equal(deadlines.get(request.signal), url === `${assetBase}${data.tag}/${data.assetName}` ? 300_000 : 60_000);
  }
  assert.equal(phases.length, 5);
  assert.match(phases[0], /latest official stable/);
  assert.match(phases.at(-1), /publishing the runtime receipt/);
  assert.ok(phases.every((message) => !message.includes('public-anonymous-pull-token')));
});

test('every install resolves latest again and preserves earlier verified bundles', async () => {
  const destination = await directory('refresh-');
  const first = fixture();
  const prior = await install(first, destination);
  const second = fixture({ tag: 'v0.2.22' });
  const next = await install(second, destination);
  assert.equal(next.tag, 'v0.2.22');
  assert.notEqual(prior.cliPath, next.cliPath);
  assert.deepEqual(await readFile(prior.cliPath), first.cli);
  assert.equal(JSON.parse(await readFile(next.receiptPath)).tag, next.tag);
  assert.equal(first.calls.filter(({ url }) => url === RELEASES_URL).length, 1);
  assert.equal(second.calls.filter(({ url }) => url === RELEASES_URL).length, 1);
  assert.equal((await readdir(join(destination, 'versions'))).length, 2);
});

test('unreachable latest fails explicitly even when an older verified receipt exists', async () => {
  const destination = await directory('no-fallback-');
  const prior = await install(fixture(), destination);
  const oldReceipt = await readFile(prior.receiptPath);
  const failing = fixture();
  failing.routes.set(RELEASES_URL, { error: new Error('network failure') });
  await assert.rejects(install(failing, destination), /latest stable release could not be fetched/);
  assert.deepEqual(await readFile(prior.receiptPath), oldReceipt);
  assert.equal((await readdir(join(destination, 'versions'))).filter((name) => !name.startsWith('.staging-')).length, 1);
});

test('unsupported platforms fail before any HTTP or artifact writes', async () => {
  let called = false;
  for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'ia32'], ['linux', 'riscv64']]) {
    await assert.rejects(installRuntime({ directory: '/not-used', platform, arch,
      fetchImpl: async () => { called = true; } }), /supported runtime platforms/);
  }
  assert.equal(called, false);
  assert.deepEqual(runtimePlatform('linux', 'x64'), { os: 'linux', architecture: 'amd64' });
});

test('RC, draft, incomplete and untrusted releases cannot be installed', async (t) => {
  const mutations = [
    ['RC', (release) => { release.tag_name = 'v0.2.21-rc1'; }, /official stable/],
    ['prerelease', (release) => { release.prerelease = true; }, /official stable/],
    ['draft', (release) => { release.draft = true; }, /official stable/],
    ['missing provenance', (release) => { release.assets = release.assets.filter((asset) => asset.name !== 'provenance.json'); }, /exactly one provenance/],
    ['duplicate binary', (release) => { release.assets.push({ ...release.assets[0] }); }, /exactly one clutta-linux/],
    ['foreign download URL', (release) => { release.assets[0].browser_download_url = 'https://example.com/clutta-linux-amd64'; }, /trusted official/],
    ['missing metadata digest', (release) => { delete release.assets[0].digest; }, /SHA256 digest/],
    ['wrong metadata digest', (release) => { release.assets[0].digest = `sha256:${'f'.repeat(64)}`; }, /GitHub artifact metadata/],
  ];
  for (const [name, changeRelease, message] of mutations) {
    await t.test(name, async () => {
      await assert.rejects(install(fixture({ changeRelease })), message);
    });
  }
});

test('checksum list and clean source provenance are mandatory independent proofs', async (t) => {
  const mutations = [
    ['checksum mismatch', { checksum: '0'.repeat(64) }, /published checksum disagree/],
    ['dirty source', { provenance: { source_clean: false } }, /clean matching official source/],
    ['wrong product', { provenance: { product: 'other-product' } }, /clean matching official source/],
    ['wrong version', { provenance: { version: 'v0.2.19' } }, /clean matching official source/],
    ['wrong git tag', { provenance: { git_tag: 'v0.2.20' } }, /clean matching official source/],
    ['invalid revision', { provenance: { git_revision: 'main' } }, /clean matching official source/],
    ['missing platform', { provenance: { artifacts: [] } }, /platform checksum disagree/],
    ['wrong ELF platform', { elfArchitecture: 'arm64' }, /selected Linux architecture/],
  ];
  for (const [name, options, message] of mutations) {
    await t.test(name, async () => { await assert.rejects(install(fixture(options)), message); });
  }
  assert.throws(() => parseChecksums(`${'a'.repeat(64)}  x\n${'b'.repeat(64)}  x\n`), /duplicate/);
  assert.throws(() => parseChecksums(`${'a'.repeat(64)}  ../x\n`), /malformed/);
});

test('Scan platform, registry content, source labels and non-root user must match', async (t) => {
  const mutations = [
    ['registry digest', { registryDigest: `sha256:${'0'.repeat(64)}` }, /registry digest mismatch/],
    ['missing platform', { changeImageIndex: (index) => { index.manifests[0].platform.architecture = 'arm64'; } }, /matching Linux platform/],
    ['duplicate platform', { changeImageIndex: (index) => { index.manifests.push(index.manifests[0]); } }, /matching Linux platform/],
    ['wrong config platform', { changeConfig: (config) => { config.architecture = 'arm64'; } }, /do not match the CLI release/],
    ['wrong version', { changeConfig: (config) => { config.config.Labels['org.opencontainers.image.version'] = 'v0.2.19'; } }, /do not match the CLI release/],
    ['wrong source revision', { changeConfig: (config) => { config.config.Labels['org.opencontainers.image.revision'] = 'f'.repeat(40); } }, /do not match the CLI release/],
    ['wrong source repository', { changeConfig: (config) => { config.config.Labels['org.opencontainers.image.source'] = 'https://example.com/repo'; } }, /do not match the CLI release/],
    ['root image', { changeConfig: (config) => { config.config.User = '0:0'; } }, /do not match the CLI release/],
  ];
  for (const [name, options, message] of mutations) {
    await t.test(name, async () => { await assert.rejects(install(fixture(options)), message); });
  }
});

test('Helm checksum and archive metadata must agree with the selected stable release', async (t) => {
  const mutations = [
    ['no matching application', { chartEntry: { appVersion: 'v0.2.19' } }, /no published Helm chart matches/],
    ['foreign chart URL', { chartEntry: { urls: ['https://example.com/chart.tgz'] } }, /trusted URL/],
    ['wrong chart digest', { chartEntry: { digest: '0'.repeat(64) } }, /package checksum mismatch/],
    ['wrong archived application', { chartYAML: 'apiVersion: v2\nname: clutta-scan\nversion: 0.3.19\nappVersion: v0.2.19\n' }, /Chart.yaml does not match/],
    ['wrong archived chart', { chartYAML: 'apiVersion: v2\nname: clutta-scan\nversion: 0.3.18\nappVersion: v0.2.20\n' }, /Chart.yaml does not match/],
    ['invalid chart package', { chartBytes: Buffer.from('not a gzip archive') }, /metadata could not be read with tar/],
  ];
  for (const [name, options, message] of mutations) {
    await t.test(name, async () => {
      const destination = await directory();
      await assert.rejects(install(fixture(options), destination), message);
      assert.equal((await readdir(destination)).includes('current.json'), false);
    });
  }
  assert.throws(() => selectChart('entries:\n  clutta-scan: []\n', 'v0.2.20'), /no published/);
  assert.throws(() => selectChart('entries: {}\nentries: {}\n', 'v0.2.20'), /valid YAML/);
});

test('a failed late chart check leaves the previous current receipt and artifacts unchanged', async () => {
  const destination = await directory();
  const original = fixture();
  const prior = await install(original, destination);
  const priorReceipt = await readFile(prior.receiptPath);
  const next = fixture({ chartYAML: 'apiVersion: v2\nname: wrong\nversion: 0.3.19\nappVersion: v0.2.20\n' });
  await assert.rejects(install(next, destination), /Chart.yaml does not match/);
  assert.deepEqual(await readFile(prior.receiptPath), priorReceipt);
  assert.deepEqual(await readFile(prior.cliPath), original.cli);
  const versions = await readdir(join(destination, 'versions'));
  assert.equal(versions.filter((name) => !name.startsWith('.staging-')).length, 1);
  assert.equal(versions.filter((name) => name.startsWith('.staging-')).length, 1);
});

test('HTTP failure, response size and incomplete streamed assets fail explicitly', async (t) => {
  await t.test('non-success HTTP', async () => {
    const data = fixture();
    data.routes.set(RELEASES_URL, { status: 503, bytes: Buffer.from('unavailable') });
    await assert.rejects(install(data), /HTTP 503/);
  });
  await t.test('declared download limit', async () => {
    const data = fixture();
    const route = data.routes.get(`${assetBase}${data.tag}/${data.assetName}`);
    route.headers = { 'content-length': String(data.cli.length + 1) };
    await assert.rejects(install(data), /download limit/);
  });
  await t.test('truncated artifact', async () => {
    const data = fixture();
    data.routes.set(`${assetBase}${data.tag}/${data.assetName}`, { bytes: data.cli.subarray(0, 64) });
    await assert.rejects(install(data), /GitHub artifact metadata/);
  });
});

test('runtime artifacts cannot be placed inside Git or through a versions symlink', async () => {
  for (const destination of [repository, join(repository, '..inside-git'), '/', 'relative/path']) {
    await assert.rejects(install(fixture(), destination), /outside the checkout|absolute lab-owned/);
  }
  const destination = await directory();
  await symlink(repository, join(destination, 'versions'));
  await assert.rejects(install(fixture(), destination), /versions directory must be a real directory, not a symbolic link/);
  assert.equal((await readdir(destination)).includes('current.json'), false);
  const symlinkRoot = await directory();
  await symlink(repository, join(symlinkRoot, 'alias'));
  await assert.rejects(install(fixture(), join(symlinkRoot, 'alias')), /must not resolve through symbolic links/);
});

test('private runtime directories reject shared permissions, foreign owners, and redirected parents', async () => {
  const shared = await directory();
  await chmod(shared, 0o750);
  await assert.rejects(install(fixture(), shared), /no group or world permissions/);
  const privateRoot = await directory();
  const sharedVersions = join(privateRoot, 'versions');
  await mkdir(sharedVersions, { mode: 0o770 });
  await chmod(sharedVersions, 0o770);
  await assert.rejects(install(fixture(), privateRoot), /no group or world permissions/);
  const target = await directory();
  const parent = await directory();
  await symlink(target, join(parent, 'alias'));
  await assert.rejects(install(fixture(), join(parent, 'alias', 'not-created')), /must not resolve through symbolic links/);
  assert.deepEqual(await readdir(target), []);
  const metadata = { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o700, uid: process.getuid() + 1 };
  assert.throws(() => validatePrivateDirectory(metadata, 'test directory'), /owned by the current user/);
});

test('release validator rejects a platform whose binary is absent', () => {
  const data = fixture();
  assert.throws(() => validateStableRelease(data.release, 'clutta-linux-arm64'), /exactly one clutta-linux-arm64/);
});
