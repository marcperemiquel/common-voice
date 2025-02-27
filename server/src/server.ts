import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as express from 'express';
import * as Sentry from '@sentry/node';
import { NextFunction, Request, Response } from 'express';
import { importLocales } from './lib/model/db/import-locales';
import { importTargetSegments } from './lib/model/db/import-target-segments';
import { scrubUserActivity } from './lib/model/db/scrub-user-activity';
import Model from './lib/model';
import {
  getFullClipLeaderboard,
  getFullVoteLeaderboard,
} from './lib/model/leaderboard';
import { trackPageView } from './lib/analytics';
import API from './lib/api';
import { redis, useRedis, redlock } from './lib/redis';
import { APIError, ClientError, getElapsedSeconds } from './lib/utility';
import { importSentences } from './lib/model/db/import-sentences';
import { getConfig } from './config-helper';
import authRouter, { authMiddleware } from './auth-router';
import fetchLegalDocument from './fetch-legal-document';
import * as proxy from 'http-proxy-middleware';
import { createTaskQueues, TaskQueues } from './lib/takeout';
import * as compression from 'compression';
const HttpStatus = require('http-status-codes');

require('source-map-support').install();
const contributableLocales = require('locales/contributable.json');

const MAINTENANCE_VERSION_KEY = 'maintenance-version';
const FULL_CLIENT_PATH = path.join(__dirname, '..', '..', 'web');
const MAINTENANCE_PATH = path.join(__dirname, '..', '..', 'maintenance');
const RELEASE_VERSION = getConfig().RELEASE_VERSION;
const ENVIRONMENT = getConfig().ENVIRONMENT;
const PROD = getConfig().PROD;
const SECONDS_IN_A_YEAR = 365 * 24 * 60 * 60;

const CSP_HEADER = [
  `default-src 'none'`,
  `child-src 'self' blob:`,
  `style-src 'self' https://fonts.googleapis.com 'unsafe-inline'`,
  `img-src 'self' www.google-analytics.com www.gstatic.com https://www.gstatic.com https://*.amazonaws.com https://*.amazon.com https://*.blob.core.windows.net https://gravatar.com https://*.mozilla.org https://*.allizom.org data:`,
  `media-src data: blob: https://*.amazonaws.com https://*.amazon.com https://*.aina.cat https://*.blob.core.windows.net`,
  // Note: we allow unsafe-eval locally for certain webpack functionality.
  `script-src 'self' 'unsafe-eval' 'sha256-fIDn5zeMOTMBReM1WNoqqk2MBYTlHZDfCh+vsl1KomQ=' 'sha256-Hul+6x+TsK84TeEjS1fwBMfUYPvUBBsSivv6wIfKY9s=' https://www.google-analytics.com https://pontoon.mozilla.org https://sentry.prod.mozaws.net https://o1155028.ingest.sentry.io`,
  `font-src 'self' https://fonts.gstatic.com`,
  `connect-src 'self' blob: https://pontoon.mozilla.org/graphql https://*.amazonaws.com https://*.amazon.com https://*.aina.cat https://*.blob.core.windows.net https://www.gstatic.com https://www.google-analytics.com https://sentry.prod.mozaws.net https://o1155028.ingest.sentry.io https://basket.mozilla.org https://basket-dev.allizom.org https://rs.fullstory.com https://edge.fullstory.com`,
].join(';');

Sentry.init({
  dsn: getConfig().SENTRY_DSN,
  release: RELEASE_VERSION,
});

export default class Server {
  app: express.Application;
  server: http.Server;
  model: Model;
  api: API;
  taskQueues: TaskQueues;
  isLeader: boolean;

  get version() {
    const { ENVIRONMENT, RELEASE_VERSION } = getConfig();
    return ENVIRONMENT + RELEASE_VERSION;
  }

  constructor(options?: { bundleCrossLocaleMessages: boolean }) {
    options = { bundleCrossLocaleMessages: true, ...options };
    this.model = new Model();
    this.api = new API(this.model);

    useRedis.then(ready => {
      if (ready) {
        this.taskQueues = createTaskQueues(this.api.takeout);
        this.api.takeout.setQueue(this.taskQueues.dataTakeout);
      }
    });

    this.isLeader = null;

    const app = (this.app = express());

    const staticOptions = {
      setHeaders: (response: express.Response) => {
        // Basic Information
        response.set('X-Release-Version', RELEASE_VERSION);
        response.set('X-Environment', ENVIRONMENT);

        // security-centric headers
        response.removeHeader('x-powered-by');
        response.set('X-Production', PROD ? 'On' : 'Off');
        response.set('Content-Security-Policy', CSP_HEADER);
        response.set('X-Content-Type-Options', 'nosniff');
        response.set('X-XSS-Protection', '1; mode=block');
        response.set('X-Frame-Options', 'DENY');
        response.set(
          'Strict-Transport-Security',
          'max-age=' + SECONDS_IN_A_YEAR
        );
      },
    };

    // Enable Sentry request handler
    app.use(Sentry.Handlers.requestHandler());
    app.use(compression());
    if (PROD) {
      app.use(this.ensureSSL);
    }

    if (getConfig().MAINTENANCE_MODE + '' === 'true') {
      this.print('Application starting in maintenance mode');

      app.use(express.static(MAINTENANCE_PATH, staticOptions));

      app.use(/(.*)/, (request, response, next) => {
        response.sendFile('index.html', { root: MAINTENANCE_PATH });
      });
    } else {
      app.use((request, response, next) => {
        // redirect to omit trailing slashes
        if (request.path.substr(-1) == '/' && request.path.length > 1) {
          const query = request.url.slice(request.path.length);
          const host = request.get('host');
          response.redirect(
            HttpStatus.MOVED_PERMANENTLY,
            `https://${host}${request.path.slice(0, -1)}${query}`
          );
        } else {
          next();
        }
      });

      app.use(authRouter);

      app.use('/api/v1', this.api.getRouter());

      app.use(express.static(FULL_CLIENT_PATH, staticOptions));

      app.use(
        '/contribute.json',
        express.static(path.join(__dirname, '..', '..', 'contribute.json'))
      );

      if (options.bundleCrossLocaleMessages) {
        this.setupCrossLocaleRoute();
      }

      this.setupPrivacyAndTermsRoutes();

      app.use(
        /(.*)/,
        express.static(FULL_CLIENT_PATH + '/index.html', staticOptions)
      );

      // Enable Sentry error handling
      app.use(Sentry.Handlers.errorHandler());

      app.use(
        (
          error: Error,
          request: Request,
          response: Response,
          next: NextFunction
        ) => {
          console.log(error.message, error.stack);
          const isAPIError = error instanceof APIError;
          if (!isAPIError) {
            console.error(request.url, error.message, error.stack);
          }
          response
            .status(
              error instanceof ClientError
                ? HttpStatus.BAD_REQUEST
                : HttpStatus.INTERNAL_SERVER_ERROR
            )
            .json({ message: isAPIError ? error.message : '' });
        }
      );
    }
  }

  private ensureSSL(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) {
    // Set by HTTPS load-balancers like ELBs
    if (req.headers['x-forwarded-proto'] === 'http') {
      // Send to https please, always and forever
      res.redirect(
        HttpStatus.PERMANENT_REDIRECT,
        'https://' + req.headers.host + req.url
      );
    } else {
      return next();
    }
  }

  private setupCrossLocaleRoute() {
    const localesPath = path.join(FULL_CLIENT_PATH, 'locales');
    const crossLocaleMessages = fs
      .readdirSync(localesPath)
      .reduce((obj: any, locale: string) => {
        const filePath = path.join(localesPath, locale, 'cross-locale.ftl');
        if (fs.existsSync(filePath)) {
          obj[locale] = fs.readFileSync(filePath, 'utf-8');
        }
        return obj;
      }, {});

    this.app.get('/cross-locale-messages.json', (request, response) => {
      response.json(crossLocaleMessages);
    });
  }

  private setupPrivacyAndTermsRoutes() {
    this.app.get(
      '/privacy/:locale.html',
      async ({ params: { locale } }, response) => {
        response.send(await fetchLegalDocument('privacy_notice', locale));
      }
    );
    this.app.get(
      '/terms/:locale.html',
      async ({ params: { locale } }, response) => {
        response.send(await fetchLegalDocument('terms', locale));
      }
    );
    this.app.get(
      '/challenge-terms/:locale.html',
      async ({ params: { locale } }, response) => {
        response.send(await fetchLegalDocument('challenge_terms', 'en'));
      }
    );
  }

  /**
   * Log application level messages in a common format.
   */
  private print(...args: any[]) {
    args.unshift('APPLICATION --');
    console.log.apply(console, args);
  }

  /**
   * Perform any scheduled maintenance on the data model.
   */
  async performMaintenance(doImport: boolean): Promise<void> {
    const start = Date.now();
    this.print('performing Maintenance');

    try {
      await this.model.performMaintenance();
      await scrubUserActivity();
      await importLocales();

      if (doImport) {
        await importSentences(await this.model.db.mysql.createPool());
      }

      await importTargetSegments();
      this.print('Maintenance complete');
    } catch (err) {
      this.print('Maintenance error', err);
    } finally {
      this.print(`${getElapsedSeconds(start)}s to perform maintenance`);
    }
  }

  /**
   * Kill the http server if it's running.
   */
  kill(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.model.cleanUp();
  }

  /**
   * Boot up the http server.
   */
  listen(): void {
    // Begin handling requests before clip list is loaded.
    let port = getConfig().SERVER_PORT;
    this.server = this.app.listen(port, () =>
      this.print(`listening at http://localhost:${port}`)
    );
  }

  /**
   * Make sure we have a connection to the database.
   */
  async ensureDatabase(): Promise<void> {
    try {
      await this.model.ensureDatabaseSetup();
    } catch (err) {
      console.error('could not connect to db', err);
    }
  }

  async hasMigrated(): Promise<boolean> {
    this.print('checking migration status');
    const result = await redis.get(MAINTENANCE_VERSION_KEY);
    const hasMigrated = result == this.version;
    if (hasMigrated) {
      this.print('maintenance already performed');
    }
    return hasMigrated;
  }

  /**
   * Start up everything.
   */
  async run(options?: { doImport: boolean }): Promise<void> {
    options = { doImport: true, ...options };
    this.print('starting');

    await this.ensureDatabase();

    this.listen();
    const { ENVIRONMENT } = getConfig();

    if (!ENVIRONMENT || ENVIRONMENT === 'default') {
      await this.performMaintenance(options.doImport);
      // await this.warmUpCaches();
      return;
    }

    if (await this.hasMigrated()) {
      return;
    }

    this.print('acquiring lock');
    const lock = await redlock.lock(
      'common-voice-maintenance-lock',
      1000 * 60 * 60 * 6 /* keep lock for 6 hours */
    );
    // we need to check again after the lock was acquired, as another instance
    // might've already migrated in the meantime
    if (await this.hasMigrated()) {
      await lock.unlock();
      return;
    }

    try {
      await this.performMaintenance(options.doImport);
      await redis.set(MAINTENANCE_VERSION_KEY, this.version);
    } catch (e) {
      this.print('error during maintenance', e);
    }

    await lock.unlock();
    // await this.warmUpCaches();
  }

  async warmUpCaches() {
    this.print('warming up caches');
    const start = Date.now();
    for (const locale of [null].concat(contributableLocales)) {
      await this.model.getClipsStats(locale);
      await this.model.getVoicesStats(locale);
      await this.model.getContributionStats(locale);
      await getFullVoteLeaderboard(locale);
      await getFullClipLeaderboard(locale);
    }
    this.print(`took ${getElapsedSeconds(start)}s to warm up caches`);
  }

  /**
   * Reset the database to initial factory settings.
   */
  async resetDatabase(): Promise<void> {
    await this.model.db.drop();
    await this.model.ensureDatabaseSetup();
  }

  async emptyDatabase() {
    await this.model.db.empty();
  }
}
