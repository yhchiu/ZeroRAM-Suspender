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

function writeManifest(fixtureDir, version) {
  fs.writeFileSync(
    path.join(fixtureDir, 'manifest.json'),
    `{\n  "name": "Fixture",\n  "version": "${version}",\n  "permissions": ["tabs"]\n}\n`,
  );
}

function commitAll(fixtureDir, subject) {
  expect(run('git', ['add', '.'], fixtureDir).status).toBe(0);
  expect(run('git', ['commit', '-m', subject], fixtureDir).status).toBe(0);
}

function createFixture() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-log-json-'));
  const scriptPath = path.join(fixtureDir, 'git-log-json.sh');

  fs.copyFileSync(sourceScript, scriptPath);
  fs.writeFileSync(
    path.join(fixtureDir, 'package.json'),
    '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n',
  );
  writeManifest(fixtureDir, '1.0.0');
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
    // The bumped version leads the log even though nothing has landed in it yet.
    expect(changelog[0]).toMatchObject({ version: '2.3.4', items: [] });
    expect(changelog[1].version).toBe('1.0.0');
    expect(changelog[1].items).toEqual([
      { commit: expect.stringMatching(/^[0-9a-f]{40}$/), type: 'feat', subject: 'feat: initial fixture' },
    ]);
  });

  test('groups commits into the release whose version manifest.json carried', () => {
    const { fixtureDir, scriptPath } = createFixture();
    fixtureDirs.push(fixtureDir);

    // Work done while the tree says 1.0.0 ships in the release the next bump opens.
    fs.writeFileSync(path.join(fixtureDir, 'a.txt'), 'a\n');
    commitAll(fixtureDir, 'feat: add A');
    writeManifest(fixtureDir, '1.1.0');
    commitAll(fixtureDir, 'chore: update version to 1.1.0');

    fs.writeFileSync(path.join(fixtureDir, 'b.txt'), 'b\n');
    commitAll(fixtureDir, 'fix: bug B');
    writeManifest(fixtureDir, '1.2.0');
    // The older bare bump subject is dropped as release noise too.
    commitAll(fixtureDir, 'Update version to 1.2.0');

    // Touching manifest.json without changing the version is not a bump.
    fs.writeFileSync(
      path.join(fixtureDir, 'manifest.json'),
      '{\n  "name": "Fixture",\n  "version": "1.2.0",\n  "permissions": ["tabs", "alarms"]\n}\n',
    );
    commitAll(fixtureDir, 'feat: ship C');

    const result = run('sh', [shellPath(scriptPath), '1.3.0'], os.tmpdir());
    expect(result.status).toBe(0);

    const changelog = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'CHANGELOG.json')));
    expect(
      changelog.map((release) => [release.version, release.items.map((item) => item.subject)]),
    ).toEqual([
      ['1.3.0', ['feat: ship C']],
      ['1.2.0', ['fix: bug B']],
      ['1.1.0', ['feat: add A']],
      ['1.0.0', ['feat: initial fixture']],
    ]);
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
