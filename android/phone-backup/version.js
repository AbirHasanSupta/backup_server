const { execFileSync } = require('child_process');
const path = require('path');

const TAG_PATTERN = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const projectRoot = path.resolve(__dirname, '..', '..');

function normalise(tag) {
  const match = TAG_PATTERN.exec(String(tag || '').trim());
  return match ? match[1] : null;
}

function getVersion() {
  const configured = normalise(process.env.PHONE_BACKUP_VERSION);
  if (configured) return configured;
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

function androidVersionCode(version) {
  const [major, minor, patch] = version.split(/[+-]/)[0].split('.').map(Number);
  if ([major, minor, patch].some((part) => !Number.isInteger(part) || part < 0 || part > 999)) {
    throw new Error(`Cannot derive an Android versionCode from ${version}. Use SemVer components from 0 to 999.`);
  }
  return major * 1000000 + minor * 1000 + patch;
}

module.exports = { androidVersionCode, getVersion };
