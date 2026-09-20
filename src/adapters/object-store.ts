import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStore } from "./ports.js";

export interface ObjectStoreOptions {
  readonly bucket: string;
  readonly region: string;
  readonly client?: S3Client;
}

/**
 * The only S3 implementation used by the API.  Media modules deal in opaque
 * object keys and never construct provider commands themselves.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  public constructor(options: ObjectStoreOptions) {
    if (options.bucket.trim().length === 0) throw new Error("S3 bucket is required");
    if (options.region.trim().length === 0) throw new Error("AWS region is required");
    this.bucket = options.bucket;
    this.client = options.client ?? new S3Client(s3Config(options.region));
  }

  public async put(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<void> {
    assertKey(input.key);
    if (input.contentType.trim().length === 0) throw new Error("Object content type is required");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ServerSideEncryption: "AES256",
      }),
    );
  }

  public async presignGet(key: string, ttlSeconds: number): Promise<string> {
    assertKey(key);
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("S3 presign TTL must be a positive integer");
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  public async delete(key: string): Promise<void> {
    assertKey(key);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  /** Used by the media screening backlog; it remains behind this adapter. */
  public async get(key: string): Promise<Uint8Array> {
    assertKey(key);
    const output = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (output.Body === undefined) throw new Error("S3 object had no body");
    return output.Body.transformToByteArray();
  }
}

function s3Config(region: string): S3ClientConfig {
  return { region };
}

function assertKey(key: string): void {
  if (key.trim().length === 0 || key.startsWith("/") || key.includes("..")) {
    throw new Error("Invalid S3 object key");
  }
}

export function createObjectStore(options: ObjectStoreOptions): ObjectStore {
  return new S3ObjectStore(options);
}

export function createS3ObjectStore(options: ObjectStoreOptions): S3ObjectStore {
  return new S3ObjectStore(options);
}
