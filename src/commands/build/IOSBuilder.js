/**
 * @flow
 */

import fs from 'fs-extra';
import path from 'path';
import inquirer from 'inquirer';
import untildify from 'untildify';
import { Exp, Credentials, XDLError, ErrorCode } from 'xdl';
import ora from 'ora';
import chalk from 'chalk';

import type { IOSCredentials, CredentialMetadata } from 'xdl/src/Credentials';
import BaseBuilder from './BaseBuilder';
import log from '../../log';

import * as authFuncs from './auth';

const nonEmptyInput = val => val !== '';

const expertPrompt = `
WARNING! In this mode, we won't be able to make sure your certificates,
or provisioning profile are valid. Please double check that you're
uploading valid files for your app otherwise you may encounter strange errors!

Make sure you've created your app ID on the developer portal, that your app ID
is in app.json as \`bundleIdentifier\`, and that the provisioning profile you
upload matches that team ID and app ID.
`;

const produceAbsolutePath = p12Path => {
  p12Path = untildify(p12Path);
  if (!path.isAbsolute(p12Path)) {
    p12Path = path.resolve(p12Path);
  }
  return p12Path;
};

const runAsExpertQuestion = {
  type: 'list',
  name: 'isExpoManaged',
  message: 'How would you like to upload your credentials?\n',
  choices: [
    { name: 'Expo handles all credentials, you can still provide overrides', value: true },
    {
      name: 'I will provide all the credentials and files needed, Expo does limited validation',
      value: false,
    },
  ],
};

const OBLIGATORY_CREDS_KEYS = new Set([
  'certP12',
  'certPassword',
  'pushP12',
  'pushPassword',
  'provisioningProfile',
  'teamId',
]);

const LET_EXPO_HANDLE = 'Let Expo handle the process';

const I_PROVIDE_FILE = 'I want to upload my own file';

const OVERRIDE_CHOICES = [
  { name: LET_EXPO_HANDLE, value: true },
  { name: I_PROVIDE_FILE, value: false },
];

const whatToOverride = [
  {
    type: 'list',
    name: 'distCert',
    message: 'Will you provide your own Distribution Certificate?',
    choices: OVERRIDE_CHOICES,
  },
  {
    type: 'list',
    name: 'pushCert',
    message: 'Will you provide your own Push Certificate?',
    choices: OVERRIDE_CHOICES,
  },
];

const provisionProfilePath = {
  type: 'input',
  name: 'pathToProvisioningProfile',
  message: 'Path to your .mobile provisioning Profile',
  validate: authFuncs.doesFileProvidedExist.bind(null, true),
  filter: produceAbsolutePath,
};

const sharedQuestions = [
  {
    type: 'input',
    name: 'pathToP12',
    message: 'Path to P12 file:',
    validate: authFuncs.doesFileProvidedExist.bind(null, true),
    filter: produceAbsolutePath,
  },
  {
    type: 'password',
    name: 'p12Password',
    message: 'P12 password:',
    validate: password => password.length > 0,
  },
];

const appleCredsQuestions = [
  {
    type: 'input',
    name: 'appleId',
    message: `What's your Apple ID?`,
    validate: nonEmptyInput,
  },
  {
    type: 'password',
    name: 'password',
    message: `Password?`,
    validate: nonEmptyInput,
  },
];

export default class IOSBuilder extends BaseBuilder {
  async run() {
    // validate bundleIdentifier before hitting the network to check build status
    const {
      args: {
        username,
        remoteFullPackageName: experienceName,
        bundleIdentifierIOS: bundleIdentifier,
      },
    } = await Exp.getPublishInfoAsync(this.projectDir);

    if (!bundleIdentifier) {
      throw new XDLError(
        ErrorCode.INVALID_OPTIONS,
        `Your project must have a bundleIdentifier set in app.json.
See https://docs.expo.io/versions/latest/guides/building-standalone-apps.html`
      );
    }

    // Check the status of any current builds
    await this.checkStatus();
    const credentialMetadata = { username, experienceName, bundleIdentifier, platform: 'ios' };
    // Clear credentials if they want to:
    if (this.options.clearCredentials) {
      await Credentials.removeCredentialsForPlatform('ios', credentialMetadata);
      log.warn('Removed existing credentials');
    }
    if (this.options.type !== 'simulator') {
      try {
        if (authFuncs.DEBUG) {
          console.log(await authFuncs.doFastlaneActionsExist());
        }
        await authFuncs.prepareLocalAuth();
        await this.runLocalAuth(credentialMetadata);
      } catch (e) {
        log.error(`Error while gathering & validating credentials`);
        if (authFuncs.DEBUG) {
          if (e.stdout !== undefined) {
            // sometimes WSL adds null characters
            log.error(e.stdout.replace(/\0/g, ''));
          } else {
            log.error(JSON.stringify(e));
          }
        }
        throw e;
      }
    }
    // Publish the experience, if necessary
    const publishedExpIds = await this.ensureReleaseExists('ios');
    // Initiate the build with the published experience
    await this.build(publishedExpIds, 'ios');
  }

  async runningAsCI(credsStarter, credsMetadata) {
    const creds = {
      teamId: process.env.EXP_APPLE_TEAM_ID,
      certP12: process.env.EXP_DIST_CERTIFICATE_PATH,
      certPassword: process.env.EXP_DIST_CERTIFICATE_PASSWORD,
      pushP12: process.env.EXP_PUSH_CERTIFICATE_PATH,
      pushPassword: process.env.EXP_PUSH_CERTIFICATE_PASSWORD,
      provisioningProfile: process.env.EXP_PROVIONING_PROFILE_PATH,
    };

    this._copyOverAsString(credsStarter, {
      ...creds,
      provisioningProfile: (await fs.readFile(creds.provisioningProfile)).toString('base64'),
      certP12: (await fs.readFile(creds.certP12)).toString('base64'),
      pushP12: (await fs.readFile(creds.pushP12)).toString('base64'),
    });
  }

  async runningAsExpert(credsStarter) {
    log(expertPrompt);
    for (const choice of ['distCert', 'pushCert', 'provisioningProfile']) {
      await this.userProvidedOverride(credsStarter, choice);
    }
  }

  // End user wants to override these credentials, that is, they want
  // to provide their own creds
  async userProvidedOverride(credsStarter, choice) {
    switch (choice) {
      case 'distCert':
        log('Please provide your distribution certificate P12:');
        const distCertValues = await inquirer.prompt(sharedQuestions);
        this._copyOverAsString(credsStarter, {
          certP12: (await fs.readFile(distCertValues.pathToP12)).toString('base64'),
          certPassword: distCertValues.p12Password,
        });
        break;
      case 'pushCert':
        log('Please provide the path to your push notification cert P12');
        const pushCertValues = await inquirer.prompt(sharedQuestions);
        this._copyOverAsString(credsStarter, {
          pushP12: (await fs.readFile(pushCertValues.pathToP12)).toString('base64'),
          pushPassword: pushCertValues.p12Password,
        });
        break;
      case 'provisioningProfile':
        log('Please provide the path to your .mobile provisioning profile');
        const { pathToProvisioningProfile } = await inquirer.prompt(provisionProfilePath);
        this._copyOverAsString(credsStarter, {
          provisioningProfile: (await fs.readFile(pathToProvisioningProfile)).toString('base64'),
        });
        break;
      default:
        throw new Error(`Unknown choice to override: ${choice}`);
    }
  }

  _copyOverAsString(credsStarter, authActionAttempt) {
    Object.keys(authActionAttempt).forEach(k => {
      const isString = typeof authActionAttempt[k] === 'string';
      if (isString) {
        credsStarter[k] = authActionAttempt[k];
      } else {
        credsStarter[k] = JSON.stringify(authActionAttempt[k]);
      }
    });
  }

  async _ensureAppExists(appleCreds, credsMetadata, teamId, credsStarter) {
    let checkAppExistenceAttempt = await authFuncs.ensureAppIdLocally(
      appleCreds,
      credsMetadata,
      teamId
    );
    if (
      checkAppExistenceAttempt.result === 'failure' &&
      checkAppExistenceAttempt.reason.startsWith(authFuncs.NO_BUNDLE_ID)
    ) {
      checkAppExistenceAttempt = await authFuncs.createAppOnPortal(
        appleCreds,
        credsMetadata,
        teamId
      );
    }
    this._throwIfFailureWithReasonDump(checkAppExistenceAttempt);
    this._copyOverAsString(credsStarter, checkAppExistenceAttempt);
  }

  async produceProvisionProfile(appleCreds, credsMetadata, teamId, credsStarter) {
    const produceProvisionProfileAttempt = await authFuncs.produceProvisionProfile(
      appleCreds,
      credsMetadata,
      teamId
    );
    if (
      produceProvisionProfileAttempt.result === 'failure' &&
      produceProvisionProfileAttempt.reason.startsWith(authFuncs.MULTIPLE_PROFILES)
    ) {
      log.warn(
        'Consider logging into https://developer.apple.com and removing the existing provisioning profile'
      );
    }
    this._throwIfFailureWithReasonDump(produceProvisionProfileAttempt);
    this._copyOverAsString(credsStarter, produceProvisionProfileAttempt);
  }

  async expoManagedResource(credsStarter, choice, appleCreds, teamId, credsMetadata) {
    switch (choice) {
      case 'distCert':
        const produceCertAttempt = await authFuncs.produceCerts(appleCreds, teamId);
        this._throwIfFailureWithReasonDump(produceCertAttempt);
        this._copyOverAsString(credsStarter, produceCertAttempt);
        break;
      case 'pushCert':
        const producePushCertsAttempt = await authFuncs.producePushCerts(
          appleCreds,
          credsMetadata,
          teamId
        );
        this._throwIfFailureWithReasonDump(producePushCertsAttempt);
        this._copyOverAsString(credsStarter, producePushCertsAttempt);
        break;
      case 'provisioningProfile':
        await this.produceProvisionProfile(appleCreds, credsMetadata, teamId, credsStarter);
        break;
      default:
        throw new Error(`Unknown manage resource choice requested: ${choice}`);
    }
  }

  async _validateCredsEnsureAppExists(credsStarter, credsMetadata, justTeamId) {
    const appleCredentials = await this.askForAppleCreds(justTeamId);
    log('Validating Credentials...');
    const checkCredsAttempt = await authFuncs.validateCredentialsProduceTeamId(appleCredentials);
    this._throwIfFailureWithReasonDump(checkCredsAttempt);
    credsStarter.teamId = checkCredsAttempt.teamId;
    await this._ensureAppExists(
      appleCredentials,
      credsMetadata,
      checkCredsAttempt.teamId,
      credsStarter
    );
    return appleCredentials;
  }

  async runningAsExpoManaged(appleCredentials, credsStarter, credsMetadata) {
    const expoManages = { ...(await inquirer.prompt(whatToOverride)), provisioningProfile: true };
    const spinner = ora('Running local authentication and producing required credentials').start();
    try {
      for (const choice of Object.keys(expoManages)) {
        spinner.text = `Now producing files for ${choice}`;
        if (expoManages[choice]) {
          spinner.start();
          await this.expoManagedResource(
            credsStarter,
            choice,
            appleCredentials,
            credsStarter.teamId,
            credsMetadata
          );
        } else {
          spinner.stop();
          await this.userProvidedOverride(credsStarter, choice);
        }
      }
    } catch (e) {
      throw e;
    } finally {
      spinner.stop();
    }
  }

  _areCredsMissing(creds, action) {
    const clientHas = new Set(Object.keys(creds));
    const credsMissing = [];
    for (const k of OBLIGATORY_CREDS_KEYS.keys()) {
      if (clientHas.has(k) === false) {
        credsMissing.push(k);
        action !== undefined && action();
      }
    }
    if (credsMissing.length !== 0) {
      log.warn(`We do not have some credentials for you, ${credsMissing}`);
    }
  }

  async runLocalAuth(credsMetadata) {
    let credsStarter = await Credentials.credentialsExistForPlatformAsync(credsMetadata);
    let clientHasAllNeededCreds = false;
    if (credsStarter !== undefined) {
      clientHasAllNeededCreds = true;
      this._areCredsMissing(credsStarter, () => (clientHasAllNeededCreds = false));
    } else {
      credsStarter = {};
    }
    
    if (this.options.useCi) {
      await this.runningAsCI(credsStarter, credsMetadata);
      this._areCredsMissing(credsStarter);
      await Credentials.updateCredentialsForPlatform('ios', credsStarter, credsMetadata);
      log.warn(`Encrypted ${[...OBLIGATORY_CREDS_KEYS.keys()]} and saved to expo servers`);
    } else if (clientHasAllNeededCreds === false) {
      // We just keep mutating the creds object.
      const strategy = await inquirer.prompt(runAsExpertQuestion);
      const appleCredentials = await this._validateCredsEnsureAppExists(
        credsStarter,
        credsMetadata,
        !strategy.isExpoManaged
      );
      if (strategy.isExpoManaged) {
        await this.runningAsExpoManaged(appleCredentials, credsStarter, credsMetadata);
      } else {
        await this.runningAsExpert(credsStarter);
      }
      const { result, ...creds } = credsStarter;
      if (authFuncs.DEBUG) {
        console.log(credsStarter);
      }
      this._areCredsMissing(creds);
      await Credentials.updateCredentialsForPlatform('ios', creds, credsMetadata);
      log.warn(`Encrypted ${[...OBLIGATORY_CREDS_KEYS.keys()]} and saved to expo servers`);
    } else {
      log('Using existing credentials for this build');
    }
  }

  _throwIfFailureWithReasonDump(replyAttempt) {
    if (authFuncs.DEBUG) {
      console.log(replyAttempt);
    }
    if (replyAttempt.result === 'failure') {
      const { reason, rawDump } = replyAttempt;
      throw new Error(`Reason:${reason}, raw:${JSON.stringify(rawDump)}`);
    }
  }

  async askForAppleCreds(justTeamId = false): Promise<IOSCredentials> {
    if (justTeamId === false) {
      console.log(`
We need your Apple ID/password to manage certificates and
provisioning profiles from your Apple Developer account.

Note: Expo does not keep your Apple ID or your Apple password.
`);
    } else {
      console.log(`
We need your Apple ID/password to ensure the correct teamID and appID

Note: Expo does not keep your Apple ID or your Apple password.
`);
    }
    return inquirer.prompt(appleCredsQuestions);
  }
}
