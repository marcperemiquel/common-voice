import { getConfig } from '../config-helper';
import { SQS, S3 } from 'aws-sdk';

const awsDefaults = {
  signatureVersion: 'v4',
  useDualstack: false,
  region: getConfig().BUCKET_LOCATION,
};

export namespace AWS {
  let s3 = new S3({ ...awsDefaults, ...getConfig().S3_CONFIG });
  let s3Public = new S3({ ...awsDefaults, ...getConfig().S3_PUBLIC_CONFIG });
  let sqs = new SQS({
    ...awsDefaults,
    region: 'us-east-1',
    ...getConfig().CINCHY_CONFIG,
  });

  export function getS3() {
    return s3;
  }

  export function getS3Public() {
    return s3Public;
  }

  export function getSqs() {
    return sqs;
  }
}
