export interface Env {
  DB: D1Database;
  NAS_TOKEN?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUD?: string;
  MEDIA_PUBLIC_BASE_URL?: string;
  MEDIA_ORIGIN_BASE_URL?: string;
  MEDIA_ORIGIN_ACCESS_CLIENT_ID?: string;
  MEDIA_ORIGIN_ACCESS_CLIENT_SECRET?: string;
  MEDIA_BUCKET?: R2Bucket;
}
