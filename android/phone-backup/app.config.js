const { androidVersionCode, getVersion } = require('./version');
const baseConfig = require('./app.json');

const version = getVersion();
if (!version) {
  throw new Error(
    'No release version is available. Create a Git tag such as v4.5.0, run npm run version:sync, '
    + 'or set PHONE_BACKUP_VERSION before running an Expo build.',
  );
}

module.exports = {
  expo: {
    ...baseConfig.expo,
    version,
    android: {
      ...baseConfig.expo.android,
      versionCode: androidVersionCode(version),
    },
  },
};
