const fs = require('fs');
const { exec } = require('child_process');

/* eslint-disable no-console */

const getVersion = async environmentName => new Promise((resolve, reject) => {
  exec(`npm show ${environmentName} version`, (err, stdout) => {
    if (err) {
      reject(err);
      return;
    }

    resolve(stdout.trim());
  });
});

// eslint-disable-next-line wrap-iife,func-names
(async function () {
  try {
    const environmentName = process.env.ENVIRONMENT;
    if (!environmentName) {
      throw new Error('Environment should be set');
    }
    const environmentVersion = await getVersion(environmentName);
    if (!environmentVersion) {
      throw new Error('Cannot detect latest environment version');
    }
    const pkg = {
      private: true,
      name: 'goose-parser',
      dependencies: {
        [environmentName]: `^${environmentVersion}`,
      },
    };
    fs.writeFileSync('./package.json', JSON.stringify(pkg, null, '  '), 'utf-8');
    fs.writeFileSync('./environment.js', `module.exports = require('${environmentName}');`, 'utf-8');
  } catch (e) {
    console.log('Error occurred');
    console.log(e.message, e.stack);
    process.exit(1);
  }
})();
