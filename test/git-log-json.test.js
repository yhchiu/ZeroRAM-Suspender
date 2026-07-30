const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sourceScript = path.join(__dirname, '..', 'git-log-json.sh');

function shellPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  return filePath
    .replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`)
    .replace(/\\/g, '/');
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  });
}

function createFixture() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-log-json-'));
  const scriptPath = path.join(fixtureDir, 'git-log-json.sh');

  fs.copyFileSync(sourceScript, scriptPath);
  fs.writeFileSync(
    path.join(fixtureDir, 'package.json'),
    '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n',
  );
  fs.writeFileSync(
    path.join(fixtureDir, 'manifest.json'),
    '{\n  "name": "Fixture",\n  "version": "1.0.0",\n  "permissions": ["tabs"]\n}\n',
  );
  fs.writeFileSync(
    path.join(fixtureDir, 'package-lock.json'),
    '{\n  "name": "fixture",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "fixture",\n      "version": "1.0.0"\n    }\n  }\n}\n',
  );

  expect(run('git', ['init'], fixtureDir).status).toBe(0);
  expect(run('git', ['config', 'user.email', 'test@example.com'], fixtureDir).status).toBe(0);
  expect(run('git', ['config', 'user.name', 'Test User'], fixtureDir).status).toBe(0);
  expect(run('git', ['add', '.'], fixtureDir).status).toBe(0);
  expect(run('git', ['commit', '-m', 'feat: initial fixture'], fixtureDir).status).toBe(0);

  return { fixtureDir, scriptPath };
}

describe('git-log-json.sh', () => {
  const fixtureDirs = [];

  afterEach(() => {
    fixtureDirs.splice(0).forEach((fixtureDir) => {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    });
  });

  test('updates all project versions and regenerates the changelog from another directory', () => {
    const { fixtureDir, scriptPath } = createFixture();
    fixtureDirs.push(fixtureDir);

    const result = run('sh', [shellPath(scriptPath), '2.3.4'], os.tmpdir());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(fs.readFileSync(path.join(fixtureDir, 'package.json'))).version).toBe('2.3.4');
    expect(JSON.parse(fs.readFileSync(path.join(fixtureDir, 'manifest.json'))).version).toBe('2.3.4');

    const lock = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'package-lock.json')));
    expect(lock.version).toBe('2.3.4');
    expect(lock.packages[''].version).toBe('2.3.4');

    const manifestText = fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8');
    expect(manifestText).toContain('"permissions": ["tabs"]');

    const changelog = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'CHANGELOG.json')));
    expect(changelog[0].commit.message).toBe('feat: initial fixture');
  });

  test('rejects invalid Chrome manifest versions without changing files', () => {
    const { fixtureDir, scriptPath } = createFixture();
    fixtureDirs.push(fixtureDir);
    const packageBefore = fs.readFileSync(path.join(fixtureDir, 'package.json'), 'utf8');

    const result = run('sh', [shellPath(scriptPath), '1.2.3.4.5'], os.tmpdir());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid version '1.2.3.4.5'");
    expect(fs.readFileSync(path.join(fixtureDir, 'package.json'), 'utf8')).toBe(packageBefore);
    expect(fs.existsSync(path.join(fixtureDir, 'CHANGELOG.json'))).toBe(false);
  });
});
