import { PassThrough } from 'stream';
import { S3 } from 'aws-sdk';
import * as bodyParser from 'body-parser';
import { MD5 } from 'crypto-js';
import { NextFunction, Request, Response, Router } from 'express';
import * as sendRequest from 'request-promise-native';
import { UserClient as UserClientType } from 'common';
import { authMiddleware } from '../auth-router';
import { getConfig, CommonVoiceConfig } from '../config-helper';
import Awards from './model/awards';
import CustomGoal from './model/custom-goal';
import getGoals from './model/goals';
import UserClient from './model/user-client';
import { AWS } from './aws';
import * as Basket from './basket';
import Bucket from './bucket';
import Clip from './clip';
import Model from './model';
import Prometheus from './prometheus';
import { ClientParameterError } from './utility';
import Challenge from './challenge';
import { features } from 'common';
import { taxonomies } from 'common';
import Takeout from './takeout';

const Transcoder = require('stream-transcoder');

const PromiseRouter = require('express-promise-router');

export default class API {
  model: Model;
  clip: Clip;
  challenge: Challenge;
  metrics: Prometheus;
  private readonly s3: S3;
  private readonly s3Public: S3;
  private readonly bucket: Bucket;
  readonly takeout: Takeout;

  constructor(model: Model) {
    this.model = model;
    this.clip = new Clip(this.model);
    this.challenge = new Challenge(this.model);
    this.metrics = new Prometheus();
    this.s3 = AWS.getS3();
    this.s3Public = AWS.getS3Public();
    this.bucket = new Bucket(this.model, this.s3, this.s3Public);
    this.takeout = new Takeout(this.model.db.mysql, this.s3, this.bucket);
  }

  getRouter(): Router {
    const router = PromiseRouter();

    router.use(bodyParser.json());

    router.use((request: Request, response: Response, next: NextFunction) => {
      this.metrics.countRequest(request);
      next();
    }, authMiddleware);

    router.get('/metrics', (request: Request, response: Response) => {
      this.metrics.countPrometheusRequest(request);

      const { registry } = this.metrics;
      response.type(registry.contentType).status(200).end(registry.metrics());
    });

    router.use((request: Request, response: Response, next: NextFunction) => {
      this.metrics.countApiRequest(request);
      next();
    });

    router.get('/golem', (request: Request, response: Response) => {
      console.log('Received a Golem request', {
        referer: request.header('Referer'),
        query: request.query,
      });
      response.redirect('/');
    });

    router.get('/health', this.getHealth);
    router.get('/user_clients', this.getUserClients);
    router.post('/user_clients/:client_id/claim', this.claimUserClient);
    router.get('/user_client', this.getAccount);
    router.patch('/user_client', this.saveAccount);
    router.post(
      '/user_client/avatar/:type',
      bodyParser.raw({ type: 'image/*', limit: '300kb' }),
      this.saveAvatar
    );
    router.post('/user_client/avatar_clip', this.saveAvatarClip);
    router.get('/user_client/avatar_clip', this.getAvatarClip);
    router.get('/user_client/delete_avatar_clip', this.deleteAvatarClip);
    router.post('/user_client/:locale/goals', this.createCustomGoal);
    router.get('/user_client/goals', this.getGoals);
    router.get('/user_client/:locale/goals', this.getGoals);
    router.post('/user_client/awards/seen', this.seenAwards);
    router.get('/user_client/takeout', this.getTakeouts);
    router.post('/user_client/takeout/request', this.requestTakeout);
    router.post('/user_client/takeout/:id/links', this.getTakeoutLinks);

    router.get('/language/accents/:locale?', this.getAccents);
    router.get('/language/variants/:locale?', this.getVariants);

    router.get('/:locale/sentences', this.getRandomSentences);
    router.post('/skipped_sentences/:id', this.createSkippedSentence);
    router.post('/skipped_clips/:id', this.createSkippedClip);

    router.use(
      '/:locale?/clips',
      (request: Request, response: Response, next: NextFunction) => {
        this.metrics.countClipRequest(request);
        next();
      },
      this.clip.getRouter()
    );

    router.get('/contribution_activity', this.getContributionActivity);
    router.get('/:locale/contribution_activity', this.getContributionActivity);

    router.get('/requested_languages', this.getRequestedLanguages);
    router.post('/requested_languages', this.createLanguageRequest);

    router.get('/language_stats', this.getLanguageStats);

    router.post('/newsletter/:email', this.subscribeToNewsletter);

    router.post('/:locale/downloaders', this.insertDownloader);

    router.post('/reports', this.createReport);

    router.use('/challenge', this.challenge.getRouter());

    router.get('/feature/:locale/:feature', this.getFeatureFlag);
    router.get('/bucket/:bucket_type/:path/:cdn', this.getPublicUrl);
    router.get('/server_date', this.getServerDate);

    router.use('*', (request: Request, response: Response) => {
      response.sendStatus(404);
    });

    return router;
  }

  getFeatureFlag = (
    { params: { locale, feature } }: Request,
    response: Response
  ) => {
    let featureResult = null;
    const featureObj = features[feature];

    try {
      if (
        featureObj &&
        ((featureObj.taxonomy &&
          taxonomies[featureObj.taxonomy] &&
          taxonomies[featureObj.taxonomy].locales.includes(locale)) ||
          featureObj.taxonomy === undefined) &&
        getConfig()[featureObj.configFlag as keyof CommonVoiceConfig]
      ) {
        featureResult = featureObj;
      }
    } catch (e) {
      console.log('error retrieving feature flag', e.message);
    }

    response.json(featureResult);
  };

  getRandomSentences = async (request: Request, response: Response) => {
    const { client_id, params } = request;
    const count = this.getCountQueryParam(request) || 1;
    const sentences = await this.model.findEligibleSentences(
      client_id,
      params.locale,
      count
    );

    response.json(sentences);
  };

  getRequestedLanguages = async (request: Request, response: Response) => {
    response.json(await this.model.db.getRequestedLanguages());
  };

  createLanguageRequest = async (request: Request, response: Response) => {
    await this.model.db.createLanguageRequest(
      request.body.language,
      request.client_id
    );
    response.json({});
  };

  createSkippedSentence = async (request: Request, response: Response) => {
    const {
      client_id,
      params: { id },
    } = request;
    await this.model.db.createSkippedSentence(id, client_id);
    response.json({});
  };

  createSkippedClip = async (request: Request, response: Response) => {
    const {
      client_id,
      params: { id },
    } = request;
    await this.model.db.createSkippedClip(id, client_id);
    response.json({});
  };

  getLanguageStats = async (request: Request, response: Response) => {
    response.json(await this.model.getLanguageStats());
  };

  getUserClients = async ({ client_id, user }: Request, response: Response) => {
    if (!user) {
      response.json([]);
      return;
    }

    const email = user.emails[0].value;
    const enrollment = user.enrollment;
    const userClients: UserClientType[] = [
      { email, enrollment },
      ...(await UserClient.findAllWithLanguages({
        email,
        client_id,
      })),
    ];
    response.json(userClients);
  };

  saveAccount = async (request: Request, response: Response) => {
    const { body, user } = request;
    if (!user) {
      throw new ClientParameterError();
    }
    response.json(await UserClient.saveAccount(user.emails[0].value, body));
  };

  getAccount = async ({ user }: Request, response: Response) => {
    let userData = null;
    if (user) {
      userData = await UserClient.findAccount(user.emails[0].value);
    }

    if (userData !== null && userData.avatar_clip_url !== null) {
      userData.avatar_clip_url = await this.bucket.getAvatarClipsUrl(
        userData.avatar_clip_url
      );
    }

    response.json(user ? userData : null);
  };

  subscribeToNewsletter = async (request: Request, response: Response) => {
    const { BASKET_API_KEY } = getConfig();
    if (!BASKET_API_KEY) {
      response.json({});
      return;
    }

    const { email } = request.params;
    const basketResponse = await sendRequest({
      uri: Basket.BASKET_API_URL + '/news/subscribe/',
      method: 'POST',
      form: {
        'api-key': BASKET_API_KEY,
        newsletters: 'common-voice',
        format: 'H',
        lang: 'en',
        email,
        source_url: request.header('Referer'),
        sync: 'Y',
      },
    });
    const clientId = await UserClient.updateBasketToken(
      email,
      JSON.parse(basketResponse).token
    );
    await Basket.sync(clientId, true);

    response.json({});
  };

  saveAvatar = async (
    { body, headers, params, user, client_id }: Request,
    response: Response
  ) => {
    let avatarURL;
    let error;
    switch (params.type) {
      case 'default':
        avatarURL = null;
        break;

      case 'gravatar':
        try {
          avatarURL =
            'https://gravatar.com/avatar/' +
            MD5(user.emails[0].value).toString() +
            '.png';
          await sendRequest(avatarURL + '&d=404');
        } catch (e) {
          if (e.name != 'StatusCodeError') {
            throw e;
          }
          error = 'not_found';
        }
        break;

      case 'file':
        // Because avatar files are uploaded as public, this is a nominally
        // unpredictable prefix to prevent easy guessing of avatar location
        const prefix = (new Date().getUTCMilliseconds() * Math.random())
          .toString(36)
          .slice(-5);

        let fileName = `${client_id}/${prefix}-avatar.jpeg`;
        await this.s3
          .upload({
            Key: fileName,
            Bucket: getConfig().CLIP_BUCKET_NAME,
            Body: body,
            ACL: 'public-read',
          })
          .promise();

        avatarURL = this.bucket.getUnsignedUrl(
          getConfig().CLIP_BUCKET_NAME,
          fileName
        );
        break;

      default:
        response.sendStatus(404);
        return;
    }

    if (!error) {
      const oldAvatar = await UserClient.updateAvatarURL(
        user.emails[0].value,
        avatarURL
      );
      if (oldAvatar) await this.bucket.deleteAvatar(client_id, oldAvatar);
    }

    response.json(error ? { error } : {});
  };

  // TODO: Check for empty or silent clips before uploading.
  saveAvatarClip = async (request: Request, response: Response) => {
    const { client_id, headers, user } = request;
    console.log(`VOICE_AVATAR: saveAvatarClip() called, ${client_id}`);
    const folder = client_id;
    const clipFileName = folder + '.mp3';
    try {
      // If upload was base64, make sure we decode it first.
      let transcoder;
      if ((headers['content-type'] as string).includes('base64')) {
        // If we were given base64, we'll need to concat it all first
        // So we can decode it in the next step.
        console.log(
          `VOICE_AVATAR: base64 to saveAvatarClip(), ${clipFileName}`
        );
        const chunks: Buffer[] = [];
        await new Promise(resolve => {
          request.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          request.on('end', resolve);
        });
        const passThrough = new PassThrough();
        passThrough.end(
          Buffer.from(Buffer.concat(chunks).toString(), 'base64')
        );
        transcoder = new Transcoder(passThrough);
      } else {
        // For non-base64 uploads, we can just stream data.
        transcoder = new Transcoder(request);
      }

      await Promise.all([
        this.s3
          .upload({
            Bucket: getConfig().CLIP_BUCKET_NAME,
            Key: clipFileName,
            Body: transcoder.audioCodec('mp3').format('mp3').stream(),
          })
          .promise(),
      ]);

      await UserClient.updateAvatarClipURL(user.emails[0].value, clipFileName);

      response.json(clipFileName);
    } catch (error) {
      console.error(error);
      response.statusCode = error.statusCode || 500;
      response.statusMessage = 'save avatar clip error';
      response.json(error);
    }
  };

  getAvatarClip = async (request: Request, response: Response) => {
    try {
      const { user } = request;
      let path = await UserClient.getAvatarClipURL(user.emails[0].value);
      path = path[0][0].avatar_clip_url;

      let avatarclip = await this.bucket.getAvatarClipsUrl(path);
      response.json(avatarclip);
    } catch (err) {
      response.json(null);
    }
  };

  deleteAvatarClip = async (request: Request, response: Response) => {
    const { user } = request;
    await UserClient.deleteAvatarClipURL(user.emails[0].value);
    response.json('deleted');
  };

  getTakeouts = async (request: Request, response: Response) => {
    const takeouts = await this.takeout.getClientTakeouts(request.client_id);
    response.json(takeouts);
  };

  requestTakeout = async (request: Request, response: Response) => {
    try {
      // Throws if there is a pending takeout.
      const takeout_id = await this.takeout.startTakeout(request.client_id);
      response.json({ takeout_id });
    } catch (err) {
      response.status(400).json(err.message);
    }
  };

  getTakeoutLinks = async (request: Request, response: Response) => {
    const {
      client_id,
      params: { id },
    } = request;
    const links = await this.takeout.generateDownloadLinks(
      client_id,
      parseInt(id)
    );
    response.json(links);
  };

  getContributionActivity = async (
    { client_id, params: { locale }, query }: Request,
    response: Response
  ) => {
    response.json(
      await (query.from == 'you'
        ? this.model.db.getContributionStats(locale, client_id)
        : this.model.getContributionStats(locale))
    );
  };

  createCustomGoal = async (request: Request, response: Response) => {
    await CustomGoal.create(
      request.client_id,
      request.params.locale,
      request.body
    );
    response.json({});
    Basket.sync(request.client_id).catch(e => console.error(e));
  };

  getGoals = async (
    { client_id, params: { locale } }: Request,
    response: Response
  ) => {
    response.json({ globalGoals: await getGoals(client_id, locale) });
  };

  claimUserClient = async (
    { client_id, params }: Request,
    response: Response
  ) => {
    if (!(await UserClient.hasSSO(params.client_id)) && client_id) {
      await UserClient.claimContributions(client_id, [params.client_id]);
    }
    response.json({});
  };

  insertDownloader = async (
    { client_id, body }: Request,
    response: Response
  ) => {
    await this.model.db.insertDownloader(body.locale, body.email, body.dataset);
    response.json({});
  };

  seenAwards = async ({ client_id, query }: Request, response: Response) => {
    await Awards.seen(
      client_id,
      query.hasOwnProperty('notification') ? 'notification' : 'award'
    );
    response.json({});
  };

  createReport = async ({ client_id, body }: Request, response: Response) => {
    await this.model.db.createReport(client_id, body);
    response.json({});
  };

  getPublicUrl = async (
    { params: { bucket_type, path, cdn } }: Request,
    response: Response
  ) => {
    const url = await this.bucket.getPublicUrl(
      decodeURIComponent(path),
      bucket_type,
      cdn == 'true'
    );
    response.json({ url });
  };

  getServerDate = (request: Request, response: Response) => {
    // prevents contributors manipulating dates in client
    response.json(new Date());
  };

  getAccents = async ({ client_id, params }: Request, response: Response) => {
    response.json(
      await this.model.db.getAccents(client_id, params?.locale || null)
    );
  };

  getHealth = async (request: Request, response: Response) => {
    try {
      //
      const count = await this.model.db.checkConnectivity();
      if (count === -1) {
        response.sendStatus(500);
      } else {
        response.json('Ok');
      }
    } catch (err) {
      response.status(400).json(err.message);
    }
  };

  getVariants = async ({ client_id, params }: Request, response: Response) => {
    response.json(
      await this.model.db.getVariants(client_id, params?.locale || null)
    );
  };

  private getCountQueryParam = (request: Request) => {
    const { count } = request.query;

    if (typeof count !== 'string') {
      return null;
    }

    const countNumberResult = parseInt(count, 10);

    // handle if we don't have a number sent
    if (Number.isNaN(countNumberResult)) {
      return null;
    }

    return countNumberResult;
  };
}
