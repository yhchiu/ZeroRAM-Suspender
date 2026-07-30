#!/bin/sh
set -eu

# Regenerates CHANGELOG.json from git history.
#
# Usage: ./git-log-json.sh [new-version]
#
# With a version argument (e.g. ./git-log-json.sh 1.8.0), package.json,
# package-lock.json, and manifest.json are first updated to that version.
# With no argument, only CHANGELOG.json is regenerated.
#
# The script can be run from anywhere; all paths are relative to its location.

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

git log --no-merges --format='%H|%s|%aN|%aI' | \
awk -F'|' '
BEGIN { print "[" }
{
  gsub(/"/, "\\\"", $2)
  gsub(/"/, "\\\"", $3)
  if (NR > 1) print ","
  printf "{\n"
  printf "  \"sha\": \"%s\",\n", $1
  printf "  \"html_url\": \"https://github.com/yhchiu/ZeroRAM-Suspender/commit/%s\",\n", $1
  printf "  \"commit\": {\n"
  printf "    \"message\": \"%s\",\n", $2
  printf "    \"author\": {\n"
  printf "      \"name\": \"%s\",\n", $3
  printf "      \"date\": \"%s\"\n", $4
  printf "    }\n"
  printf "  }\n"
  printf "}"
}
END { print "\n]" }
' > CHANGELOG.json

