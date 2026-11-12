const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withForegroundService(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = manifest.manifest.application[0];

    if (!application.service) {
      application.service = [];
    }

    const serviceExists = application.service.some(
      (s) => s.$?.['android:name'] === 'com.voximplant.foregroundservice.VIForegroundService'
    );

    if (!serviceExists) {
      application.service.push({
        $: {
          'android:name': 'com.voximplant.foregroundservice.VIForegroundService',
          'android:foregroundServiceType': 'dataSync',
          'android:exported': 'false',
        },
      });
    }

    return config;
  });
};
