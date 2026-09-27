const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TAG_PATTERN = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const projectRoot = path.resolve(__dirname, '..', '..');

function normalise(tag) {
  const match = TAG_PATTERN.exec(String(tag || '').trim());
  return match ? match[1] : null;
}

function gitVersion() {
  try {
    return normalise(execFileSync(
      'git',
      ['-C', projectRoot, 'describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--match', '[0-9]*'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ));
  } catch (_) {
    return null;
  }
}

function bundledVersion() {
  for (const candidate of [path.join(projectRoot, 'VERSION'), path.join(__dirname, 'VERSION')]) {
    try {
      const version = normalise(fs.readFileSync(candidate, 'utf8'));
      if (version) return version;
    } catch (_) {
      // Missing or unreadable VERSION files are expected outside packaged builds.
    }
  }
  return null;
}

function packageVersion() {
  try {
    return normalise(require('./package.json').version);
  } catch (_) {
    return null;
  }
}

function getVersion() {
  // EAS Build archives omit .git, so fall back to VERSION / package.json after env + tag lookup.
  return normalise(process.env.PHONE_BACKUP_VERSION)
    || gitVersion()
    || bundledVersion()
    || packageVersion();
}

function androidVersionCode(version) {
  const [major, minor, patch] = version.split(/[+-]/)[0].split('.').map(Number);
  if ([major, minor, patch].some((part) => !Number.isInteger(part) || part < 0 || part > 999)) {
    throw new Error(`Cannot derive an Android versionCode from ${version}. Use SemVer components from 0 to 999.`);
  }
  return major * 1000000 + minor * 1000 + patch;
}

module.exports = { androidVersionCode, getVersion };
