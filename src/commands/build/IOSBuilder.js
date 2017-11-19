/**
 * @flow
 */

import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import untildify from 'untildify';
import { Exp, Credentials, XDLError, ErrorCode } from 'xdl';

import type { IOSCredentials, CredentialMetadata } from 'xdl/src/Credentials';
import BaseBuilder from './BaseBuilder';
import log from '../../log';

/**
 * Steps:
 * 1) Check for active builds -- only one build per user/experience can happen at once
 * 2) Check for Apple ID credentials for this user/experience
 * 		a) If they don't exist, prompt user to enter them. Submit them to server (/-/api/credentials/add),
 * 			 which will verify and store them.
 * 3) Check for valid cert for this user/experience
 * 		a) If valid cert doesn't exist, prompt user:
 * 	 			i) Do you have a certificate you'd like to use for signing this application, or would you like us
 * 	 				 to generate them for you?
 * 	 				 This is most common when you have other apps in the App Store, you're replacing an existing
 * 	 				 app in the App Store with an Exponent app, or you'd simply like more control over your Apple
 * 	 				 Developer account.
 * 	 	    ii) If they choose to upload a cert, ask them for the path to .p12 file. Upload the p12 (/-/api/credentials/add).
 * 	 	    iii) If they want us to manage it, call to /-/api/credentials/generate-certs, and verify that we were able to generate the cert
 * 	 	b) If a cert exists, the server will verify that it is still valid.
 * 4) Publish the experience from the local packager.
 * 5) Initiate build process.
 */
export default class IOSBuilder extends BaseBuilder {
  async run() {
    // validate bundleIdentifier before hitting the network to check build status
    const {
      args: {
        username,
        remoteFullPackageName: experienceName,
        bundleIdentifierIOS: bundleIdentifier
      }
    } = await Exp.getPublishInfoAsync(this.projectDir);

    if (!bundleIdentifier) {
      throw new XDLError(
        ErrorCode.INVALID_OPTIONS,
        `Your project must have a bundleIdentifier set in app.json. See https://docs.expo.io/versions/latest/guides/building-standalone-apps.html`
      );
    }

    // Check the status of any current builds
    await this.checkStatus();
    // Check for existing credentials, collect any missing credentials, and validate them
    if (this.options.type !== 'simulator') {
      try {
        await this.collectAndValidateCredentials(username, experienceName, bundleIdentifier);
      } catch (e) {
        log.error(
          'Error validating credentials. You may need to clear them (with `-c`) and try again.'
        );
        throw e;
      }
    }
    // Publish the experience
    const publishedExpIds = await this.publish();
    // Initiate the build with the published experience
    await this.build(publishedExpIds, 'ios');
  }

  async collectAndValidateCredentials(
    username: string,
    experienceName: string,
    bundleIdentifier: string
  ) {
    const credentialMetadata = {
      username,
      experienceName,
      bundleIdentifier,
      platform: 'ios'
    };

    log('Checking for existing Apple credentials...');
    const existingCredentials: ?IOSCredentials = await Credentials.credentialsExistForPlatformAsync(
      credentialMetadata
    );

    let hasAppleId, hasCert, hasPushCert;
    if (this.options.clearCredentials || !existingCredentials) {
      hasAppleId = false;
      hasCert = false;
      hasPushCert = false;
    } else if (existingCredentials) {
      hasAppleId = !!existingCredentials.appleId;
      hasCert = !!existingCredentials.certP12;
      hasPushCert = !!existingCredentials.pushP12;
    }

    if (!hasAppleId) {
      await this.askForAppleId(credentialMetadata);
    } else {
      log('Validating Apple credentials...');
      await Credentials.validateCredentialsForPlatform('ios', 'appleId', null, credentialMetadata);
    }
    log('Credentials valid.');

    if (!hasCert) {
      await this.askForCerts(credentialMetadata);
    } else {
      log('Validating distribution certificate...');
      await Credentials.validateCredentialsForPlatform('ios', 'cert', null, credentialMetadata);
    }

    // ensure that the app id exists or is created
    try {
      log('Validating app id...');
      await Credentials.ensureAppId(credentialMetadata);
    } catch (e) {
      throw new XDLError(
        ErrorCode.CREDENTIAL_ERROR,
        `It seems like we can't create an app on the Apple developer center with this app id: ${
          bundleIdentifier
        }. Please change your bundle identifier to something else.`
      );
    }

    if (!hasPushCert) {
      await this.askForPushCerts(credentialMetadata);
    } else {
      log('Validating push certificate...');
      await Credentials.validateCredentialsForPlatform('ios', 'push', null, credentialMetadata);
    }
  }

  async askForAppleId(credentialMetadata: CredentialMetadata) {
    const environmentAnswers = {
      appleId: process.env.EXP_APPLE_ID,
      password: process.env.EXP_APPLE_PASSWORD,
      teamId: process.env.EXP_APPLE_TEAM_ID
    };

    // ask for creds
    console.log('');
    console.log(
      'We need your Apple ID/password to manage certificates and provisioning profiles from your Apple Developer account.'
    );
    const questions = [
      {
        type: 'input',
        name: 'appleId',
        message: `What's your Apple ID?`,
        validate: val => val !== '',
        when: () => {
          // Allow the user to specify this value via an environment variable.
          if (environmentAnswers.appleId) {
            log('EXP_APPLE_ID is set in the environment, not going to ask for value.');
            return false;
          }
          delete environmentAnswers.appleId;
          return true;
        }
      },
      {
        type: 'password',
        name: 'password',
        message: `Password?`,
        validate: val => val !== '',
        when: () => {
          // Allow the user to specify this value via an environment variable.
          if (environmentAnswers.password) {
            log('EXP_APPLE_PASSWORD is set in the environment, not going to ask for value.');
            return false;
          }
          delete environmentAnswers.password;
          return true;
        }
      },
      {
        type: 'input',
        name: 'teamId',
        message: `What is your Apple Team ID (you can find that on this page: https://developer.apple.com/account/#/membership)?`,
        validate: val => val !== '',
        when: () => {
          // Allow the user to specify this value via an environment variable.
          if (environmentAnswers.teamId) {
            log('EXP_APPLE_TEAM_ID is set in the environment, not going to ask for value.');
            return false;
          }
          delete environmentAnswers.teamId;
          return true;
        }
      }
    ];

    let answers = await inquirer.prompt(questions);
    answers = Object.assign(answers, environmentAnswers);

    const credentials: IOSCredentials = {
      appleId: answers.appleId,
      password: answers.password,
      teamId: answers.teamId
    };

    log('Validating Apple credentials...');
    await Credentials.validateCredentialsForPlatform(
      'ios',
      'appleId',
      credentials,
      credentialMetadata
    );
    await Credentials.updateCredentialsForPlatform('ios', credentials, credentialMetadata);
  }

  async askForCerts(credentialMetadata: CredentialMetadata) {
    const environmentAnswers = {
      pathToP12: process.env.EXP_DIST_CERTIFICATE_PATH,
      certPassword: process.env.EXP_DIST_CERTIFICATE_PASSWORD,
      manageCertificates: true
    };

    // If we have values set for the certs then assume we don't want these to be managed.
    if (environmentAnswers.pathToP12 || environmentAnswers.certPassword) {
      environmentAnswers.manageCertificates = false;
    }

    // ask about certs
    console.log(``);

    const questions = [
      {
        type: 'rawlist',
        name: 'manageCertificates',
        message: `Do you already have a distribution certificate you'd like us to use,\nor do you want us to manage your certificates for you?`,
        choices: [
          { name: 'Let Expo handle the process!', value: true },
          { name: 'I want to upload my own certificate!', value: false }
        ],
        when: () => {
          // Allow the user to specify this value via an environment variable.
          if (!environmentAnswers.manageCertificates) {
            log(
              'EXP_DIST_CERTIFICATE_PATH and/or EXP_DIST_CERTIFICATE_PASSWORD is set in the environment, not going to ask if you want us to manage your certificates.'
            );
            return false;
          }
          delete environmentAnswers.manageCertificates;
          return true;
        }
      },
      {
        type: 'input',
        name: 'pathToP12',
        message: 'Path to P12 file:',
        validate: val => {
          return this.validateCertificatePath(val);
        },
        filter: val => {
          return this.cleanCertificatePath(val);
        },
        when: async answers => {
          // Allow the user to specify this value via an environment variable - but ignore both if we've been told to manage the certificates.
          if (answers.manageCertificates || environmentAnswers.manageCertificates) {
            delete environmentAnswers.pathToP12;
            return false;
          } else if (environmentAnswers.pathToP12) {
            if (!await this.validateCertificatePath(environmentAnswers.pathToP12)) {
              log('EXP_DIST_CERTIFICATE_PATH is set in the environment to an invalid value.');
              delete environmentAnswers.pathToP12;
              return true;
            }
            log('EXP_DIST_CERTIFICATE_PATH is set in the environment, not going to ask for value.');
            return false;
          }
          delete environmentAnswers.pathToP12;
          return true;
        }
      },
      {
        type: 'password',
        name: 'certPassword',
        message: 'Certificate P12 password:',
        validate: password => password.length > 0,
        when: answers => {
          // Allow the user to specify this value via an environment variable - but ignore both if we've been told to manage the certificates.
          if (answers.manageCertificates || environmentAnswers.manageCertificates) {
            delete environmentAnswers.certPassword;
            return false;
          } else if (environmentAnswers.certPassword) {
            log(
              'EXP_DIST_CERTIFICATE_PASSWORD is set in the environment, not going to ask for value.'
            );
            return false;
          }
          delete environmentAnswers.certPassword;
          return true;
        }
      }
    ];

    let answers = await inquirer.prompt(questions);
    answers = Object.assign(answers, environmentAnswers);

    if (answers.manageCertificates) {
      // Attempt to fetch new certificates
      log('Generating distribution certificate...');
      await Credentials.fetchAppleCertificates(credentialMetadata);
    } else {
      // Upload credentials
      const p12Data = await fs.readFile.promise(answers.pathToP12);

      const credentials: IOSCredentials = {
        certP12: p12Data.toString('base64'),
        certPassword: answers.certPassword
      };

      log('Validating distribution certificate...');
      await Credentials.validateCredentialsForPlatform(
        'ios',
        'cert',
        credentials,
        credentialMetadata
      );
      await Credentials.updateCredentialsForPlatform('ios', credentials, credentialMetadata);
    }
    log('Distribution certificate setup complete.');
  }

  async askForPushCerts(credentialMetadata: CredentialMetadata) {
    const environmentAnswers = {
      pathToP12: process.env.EXP_PUSH_CERTIFICATE_PATH,
      certPassword: process.env.EXP_PUSH_CERTIFICATE_PASSWORD,
      managePushCertificates: true
    };

    // If we have values set for the certs then assume we don't want these to be managed.
    if (environmentAnswers.pathToP12 || environmentAnswers.certPassword) {
      environmentAnswers.managePushCertificates = false;
    }

    // ask about certs
    const questions = [
      {
        type: 'rawlist',
        name: 'managePushCertificates',
        message: `Do you already have a push notification certificate you'd like us to use,\nor do you want us to manage your push certificates for you?`,
        choices: [
          { name: 'Let Expo handle the process!', value: true },
          { name: 'I want to upload my own certificate!', value: false }
        ],
        when: () => {
          // Allow the user to specify this value via an environment variable.
          if (!environmentAnswers.manageCertificates) {
            log(
              'EXP_PUSH_CERTIFICATE_PATH and/or EXP_PUSH_CERTIFICATE_PASSWORD is set in the environment, not going to ask if you want us to manage your certificates.'
            );
            return false;
          }
          delete environmentAnswers.manageCertificates;
          return true;
        }
      },
      {
        type: 'input',
        name: 'pathToP12',
        message: 'Path to P12 file:',
        validate: val => {
          return this.validateCertificatePath(val);
        },
        filter: val => {
          return this.cleanCertificatePath(val);
        },
        when: async answers => {
          // Allow the user to specify this value via an environment variable - but ignore both if we've been told to manage the certificates.
          if (answers.manageCertificates || environmentAnswers.manageCertificates) {
            delete environmentAnswers.pathToP12;
            return false;
          } else if (environmentAnswers.pathToP12) {
            if (!await this.validateCertificatePath(environmentAnswers.pathToP12)) {
              log('EXP_PUSH_CERTIFICATE_PATH is set in the environment to an invalid value.');
              delete environmentAnswers.pathToP12;
              return true;
            }
            log('EXP_PUSH_CERTIFICATE_PATH is set in the environment, not going to ask for value.');
            return false;
          }
          delete environmentAnswers.pathToP12;
          return true;
        }
      },
      {
        type: 'password',
        name: 'certPassword',
        message: 'Push certificate P12 password (empty is OK):',
        when: answers => {
          // Allow the user to specify this value via an environment variable - but ignore both if we've been told to manage the certificates.
          if (answers.manageCertificates || environmentAnswers.manageCertificates) {
            delete environmentAnswers.certPassword;
            return false;
          } else if (environmentAnswers.certPassword) {
            log(
              'EXP_PUSH_CERTIFICATE_PASSWORD is set in the environment, not going to ask for value.'
            );
            return false;
          }
          delete environmentAnswers.certPassword;
          return true;
        }
      }
    ];

    let answers = await inquirer.prompt(questions);
    answers = Object.assign(answers, environmentAnswers);

    if (answers.managePushCertificates) {
      // Attempt to fetch new certificates
      log('Fetching a new push certificate...');
      await Credentials.fetchPushCertificates(credentialMetadata);
    } else {
      // Upload credentials
      const p12Data = await fs.readFile.promise(answers.pathToP12);

      const credentials: IOSCredentials = {
        pushP12: p12Data.toString('base64'),
        pushPassword: answers.certPassword
      };

      log('Validating push certificate...');
      await Credentials.validateCredentialsForPlatform(
        'ios',
        'push',
        credentials,
        credentialMetadata
      );
      await Credentials.updateCredentialsForPlatform('ios', credentials, credentialMetadata);
    }
    log('Push certificate setup complete.');
  }

  // validators
  async validateCertificatePath(p12Path) {
    try {
      const stats = await fs.stat.promise(p12Path);
      return stats.isFile();
    } catch (e) {
      // file does not exist
      console.log('\nFile does not exist.');
      return false;
    }
  }

  cleanCertificatePath(p12Path) {
    p12Path = untildify(p12Path);
    if (!path.isAbsolute(p12Path)) {
      p12Path = path.resolve(p12Path);
    }
    return p12Path;
  }
}
