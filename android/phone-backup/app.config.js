const { androidVersionCode, getVersion } = require('./version');

module.exports = ({ config }) => {
  const version = getVersion();
  if (!version) {
    throw new Error(
      'No release version is available. Create a Git tag such as v4.5.0, run npm run version:sync, '
      + 'or set PHONE_BACKUP_VERSION before running an Expo build.',
    );
  }

  return {
    ...config,
    version,
    android: {
      ...config.android,
      versionCode: androidVersionCode(version),
    },
    extra: {
      ...config.extra,
      googleDriveApiKey: process.env.EXPO_PUBLIC_GOOGLE_DRIVE_API_KEY || '',
    },
  };
};
