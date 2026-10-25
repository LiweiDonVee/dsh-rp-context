import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from '@playwright/test'

const args = process.argv.slice(2), option = name => { const index = args.indexOf(name);return index < 0 ? undefined : args[index + 1] }
const required = name => { const value = option(name);if (!value) throw Error(`${name} is required`);return resolve(value) }
const root = process.cwd(), snapshotPath = required('--snapshot'), snapshotBytes = await readFile(snapshotPath), snapshot = JSON.parse(snapshotBytes)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const archives = { context: resolve(option('--context-tgz') ?? 'artifacts/dsh-rp-context-0.2.0.tgz'), lastStep: required('--last-step-tgz') }
const packages = Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, path]) => [name, { path, sha256: digest(await readFile(path)) }])))
const home = resolve('.runtime/context-restore-preflight-' + Date.now()), evidence = resolve(option('--evidence-dir') ?? '.runtime/restore-preflight-evidence')
const cli = process.env.DSH_BIN ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd') : 'dsh')
const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'unused-preflight-local' }
const quote = value => process.platform === 'win32' ? `"${value}"` : value
const redact = value => String(value).replace(/([?&]token=)[^\s"'<>]+/gu, '$1[REDACTED]')
await mkdir(home, { recursive: true });await mkdir(evidence, { recursive: true })
await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'context-restore-preflight-home', private: true, type: 'module' }))
let host, browser, page, logs = '', stage = 'install', result = { passed: false, home, packages, snapshot: { path: snapshotPath, sha256: digest(snapshotBytes) }, scope: 'Context + LastStep owner restore/preflight; actual imported canonical logs; no aggregate activation' }
const kill = child => new Promise(done => { if (!child?.pid) return done();if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => done());else { child.kill('SIGTERM');done() } })
const runCli = parameters => new Promise((done, reject) => {
  const child = spawn(quote(cli), parameters.map(quote), { shell: process.platform === 'win32', windowsHide: true, cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });let output = ''
  const timer = setTimeout(async () => { await kill(child);reject(Error('CLI timed out')) }, 60_000)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => output += data)
  child.on('error', error => { clearTimeout(timer);reject(error) });child.on('exit', code => { clearTimeout(timer);if (code === 0) done(output.trim());else reject(Error('CLI failed: ' + redact(output.slice(-6000)))) })
})
const patch = join(home, 'restore-preflight.patch.yml')
async function start() {
  logs = ''
  host = spawn(quote(cli), ['--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'].map(quote), { shell: process.platform === 'win32', windowsHide: true, cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [host.stdout, host.stderr]) stream.on('data', data => logs += data)
  let address;const until = Date.now() + 40_000
  while (Date.now() < until) { address = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(logs)?.[0];if (address) break;if (host.exitCode !== null) throw Error('Host exited');await new Promise(done => setTimeout(done, 100)) }
  assert.ok(address, 'Host startup timed out')
  page = await browser.newPage();await page.goto(address, { waitUntil: 'networkidle' })
  const preview = page.getByRole('button', { name: '继续', exact: true });await preview.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});if (await preview.isVisible()) await preview.click()
}
const restoreId = 'context-preflight-native-same-job'
async function request(action, extra = {}) {
  const value = await page.evaluate(async input => { const response = await fetch('api/context-restore-preflight', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });return response.json() }, { action, snapshot, restoreId, ...extra })
  assert.equal(value.ok, true, `${action}: ${JSON.stringify(value)}`);assert.equal(value.modelCalls, 0, 'Owner reads/imports unexpectedly requested models');return value
}
function checkCanonical(actual) {
  assert.equal(actual.length, snapshot.sessions.length)
  for (const expected of snapshot.sessions) {
    const value = actual.find(item => item.header.id === expected.header.id)
    assert.ok(value);assert.equal(value.live, false, 'Fixture must stay cold without an Agent')
    assert.deepEqual(value.events, expected.events);assert.equal(value.inheritedEventCount, expected.inheritedEventCount)
    assert.deepEqual({ ...value.header, delegationDepth: value.header.delegationDepth ?? 0 }, { ...expected.header, delegationDepth: expected.header.delegationDepth ?? 0 })
  }
}
function checkEqualPreflight(value) {
  assert.deepEqual(value.preflight, { supported: true, conflicts: [], requirements: [] })
  assert.deepEqual(value.afterPreflight, value.revision, 'Preflight mutated owner revision')
  assert.deepEqual(value.actual.payload, snapshot.pluginState.context.payload)
  checkCanonical(value.canonical)
  for (const proof of value.proofs) {
    const claim = snapshot.pluginState.context.payload.sessions.find(item => item.sessionId === proof.sessionId).state.noteClaims[proof.claimId]
    assert.deepEqual(proof.authorNote, { id: claim.note.id, version: claim.note.version, claimId: proof.claimId })
  }
}
const compact = value => ({ ...value, canonical: value.canonical.map(item => ({ sessionId: item.header.id, inheritedEventCount: item.inheritedEventCount, eventCount: item.events.length, eventsSha256: digest(JSON.stringify(item.events)), live: item.live })) })
try {
  result.hostVersion = await runCli(['--version']);assert.equal(result.hostVersion, '0.2.1-rc.3')
  for (const archive of Object.values(archives)) await runCli(['plugin', '--profile', 'web', 'add', archive])
  const fixture = join(home, 'restore-preflight-probe.mjs');await writeFile(fixture, await readFile('tests/fixtures/restore-preflight-probe.mjs'))
  await writeFile(patch, `- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: context-preflight-local\n    model: main\n- insert:\n    - id: context-restore-preflight-probe\n      name: ${JSON.stringify(fixture.replaceAll('\\', '/'))}\n`)
  browser = await chromium.launch({ headless: true, ...process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {} })
  stage = 'public-session-import-and-owner-restore';await start()
  const imported = await request('import');checkCanonical(imported.canonical)
  assert.deepEqual(imported.initial, { supported: true, conflicts: [], requirements: [] })
  const warm = await request('inspect');checkEqualPreflight(warm)
  stage = 'cold-process-owner-preflight';await page.close();await kill(host);host = undefined;await start()
  const cold = await request('inspect');checkEqualPreflight(cold)
  assert.deepEqual(cold.actual, warm.actual)
  stage = 'later-owner-edit-and-no-overwrite';const edited = await request('edit'), changed = await request('inspect')
  assert.deepEqual(changed.preflight, { supported: false, conflicts: [{ code: 'RESTORE_ID_CONFLICT', id: snapshot.sessions[0].header.id }], requirements: [] })
  const replay = await request('replay');assert.deepEqual(replay.restored, imported.restored);assert.deepEqual(replay.before, replay.after);assert.deepEqual(replay.after, changed.actual)
  result = { ...result, passed: true, stage: 'complete', checks: { initialPreflight: true, warmSamePayload: true, coldSamePayload: true, exactCanonicalPrefix: true, actualFrozenAuthorNoteProofs: cold.proofs.length, laterOwnerEditConflicts: true, sameJobReplayPreservesEdit: true, preflightReadOnly: true }, counts: { model: 0, writer: 0, historicalTools: 0, sessionImports: snapshot.sessions.length, contextRestores: 1, contextReplay: 1, lastStepRestores: 1, hostProcesses: 2 }, imported: compact(imported), warm: compact(warm), cold: compact(cold), edited, changed: compact(changed), replay }
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(result, null, 2));console.log(JSON.stringify({ passed: true, packages, hostVersion: result.hostVersion, checks: result.checks, counts: result.counts }))
} catch (error) {
  result = { ...result, stage, error: redact(error.stack ?? error.message) };await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(result, null, 2));await writeFile(join(evidence, 'host-redacted.log'), redact(logs));console.error(JSON.stringify(result));process.exitCode = 1
} finally { await browser?.close();await kill(host) }
