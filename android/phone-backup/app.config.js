const { androidVersionCode, getVersion } = require('./version');
const baseConfig = require('./app.json');

const version = getVersion();
if (!version) {
  throw new Error('No semantic Git tag is available. Create a tag such as v4.5.0 before running an Expo build.');
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
