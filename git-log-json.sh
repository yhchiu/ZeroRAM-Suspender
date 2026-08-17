#!/bin/sh
set -eu

# Regenerates CHANGELOG.json from git history.
#
# The release each commit belongs to comes from manifest.json, not from the
# commit subject: the version recorded in manifest.json at every commit that
# touched it is read back, and a commit where that value changes is a version
# bump. A bump commit ships its own new version, and every commit after it --
# up to and including the next bump -- belongs to the next release, because
# that work was written while the tree still carried the older version.
# Commits made since the last committed bump roll into the working-tree
# (pending) version, which sits on top.
#
# The output is fully derived from git, so any manual edits to CHANGELOG.json
# are overwritten on each run. Can be run from anywhere; it works relative to
# its own location (the repository root).
#
# Usage: ./git-log-json.sh [new-version]
#
# With a version argument (e.g. ./git-log-json.sh 1.8.0), package.json,
# package-lock.json, and manifest.json are first updated to that version, so
# the regenerated changelog lists it as the pending release.

cd "$(dirname -- "$0")"

# Chrome manifest versions are 2-4 dot-separated integers.
if [ "$#" -ge 1 ]; then
  new_version=$1
  if ! printf '%s\n' "$new_version" | grep -Eq '^[0-9]+(\.[0-9]+){1,3}$'; then
    echo "git-log-json.sh: invalid version '$new_version' (expected e.g. 1.8.0)" >&2
    exit 1
  fi

  node - "$new_version" <<'NODE'
const fs = require('fs');

const version = process.argv[2];

// Replace only the version value so hand-maintained JSON keeps its formatting.
// The first "version" string field is the package/extension version
// ("manifest_version" and "minimum_chrome_version" do not match the pattern).
function replaceVersion(fileName) {
  const text = fs.readFileSync(fileName, 'utf8');
  if (!/"version"\s*:\s*"/.test(text)) {
    throw new Error(`No version field found in ${fileName}`);
  }
  fs.writeFileSync(
    fileName,
    text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`),
  );
  console.log(`${fileName}: version set to ${version}`);
}

replaceVersion('package.json');
replaceVersion('manifest.json');

// Update both package version fields while preserving npm's standard format.
if (fs.existsSync('package-lock.json')) {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  lock.version = version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = version;
  fs.writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`package-lock.json: version set to ${version}`);
}
NODE
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/zeroram-changelog.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

git_log_file="$tmp_dir/git-log.txt"
commit_versions_file="$tmp_dir/commit-versions.txt"

# Full commit list, newest first: <hash>\x1f<subject>\x1f<date>
git log --no-merges --format='%H%x1f%s%x1f%ad' --date=short > "$git_log_file"

# Version recorded in manifest.json at each commit that touched it (the only
# commits where the version can change). Output: <hash>\x1f<version>
: > "$commit_versions_file"
for commit in $(git log --no-merges --format='%H' -- manifest.json); do
  version=$(git show "$commit:./manifest.json" 2>/dev/null \
    | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n1)
  # Octal \037, not \x1f: hex escapes are a bashism that dash prints verbatim.
  printf '%s\037%s\n' "$commit" "$version" >> "$commit_versions_file"
done

node - "$git_log_file" "$commit_versions_file" <<'NODE'
const fs = require('fs');

const CHANGELOG_FILE = 'CHANGELOG.json';
const MANIFEST_FILE = 'manifest.json';
const gitLogFile = process.argv[2];
const commitVersionsFile = process.argv[3];

// Conventional Commit type, or 'other' for the older free-form subjects; the
// options page turns this into the displayed category.
function commitType(subject) {
  const match = String(subject || '').match(/^([a-z][a-z0-9-]*)(\([^)]+\))?!?:/i);
  return match ? match[1].toLowerCase() : 'other';
}

// Version-only commits carry no user-visible change. Both the current
// "chore: update version to X" form and the older bare "Update version to X"
// (sometimes with stray leading space) are dropped.
function isReleaseNoise(subject) {
  return /^\s*(chore(\([^)]*\))?:\s*)?update version to\s/i.test(subject);
}

// commit -> version, for the commits that touched manifest.json
const commitVersion = new Map();
fs.readFileSync(commitVersionsFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .forEach((line) => {
    const [commit, version] = line.split('\x1f');
    if (commit && version) commitVersion.set(commit, version);
  });

// Full log, newest first.
const logText = fs.readFileSync(gitLogFile, 'utf8').trim();
const commits = logText
  ? logText.split('\n').map((line) => {
      const [commit, subject, date] = line.split('\x1f');
      return { commit, subject, date };
    })
  : [];

// Forward-fill the effective manifest version (oldest -> newest) and flag the
// bump commits -- the ones where the version actually changes.
let version;
[...commits].reverse().forEach((item) => {
  const recorded = commitVersion.get(item.commit);
  item.isBump = recorded !== undefined && recorded !== version;
  if (item.isBump) version = recorded;
  item.version = version;
});

const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
const pendingVersion = manifest.version;
if (!pendingVersion) {
  throw new Error(`Cannot read version from ${MANIFEST_FILE}`);
}

// Assign each commit to a release (newest -> oldest). A bump commit ships its
// own new version; every commit after a bump rolls forward into the upcoming
// release -- the working-tree version for the most recent stretch.
let upcoming = pendingVersion;
commits.forEach((item) => {
  if (item.isBump) {
    item.release = item.version;
    upcoming = item.version;
  } else {
    item.release = upcoming;
  }
});

// Group into releases, newest first, dropping release-noise commits. The
// release date is the date of the newest commit it keeps.
const releaseByVersion = new Map();
const order = [];
commits.forEach((item) => {
  if (!item.commit || !item.subject || !item.release) return;
  if (isReleaseNoise(item.subject)) return;
  if (!releaseByVersion.has(item.release)) {
    releaseByVersion.set(item.release, { version: item.release, date: item.date, items: [] });
    order.push(item.release);
  }
  releaseByVersion.get(item.release).items.push({
    commit: item.commit,
    type: commitType(item.subject),
    subject: item.subject,
  });
});

let releases = order.map((v) => releaseByVersion.get(v)).filter((release) => release.items.length);

// Surface the pending release on top even if nothing has landed in it yet.
if (!releases.some((release) => release.version === pendingVersion)) {
  releases = [
    { version: pendingVersion, date: new Date().toISOString().slice(0, 10), items: [] },
    ...releases,
  ];
}

fs.writeFileSync(CHANGELOG_FILE, `${JSON.stringify(releases, null, 2)}\n`);
NODE
