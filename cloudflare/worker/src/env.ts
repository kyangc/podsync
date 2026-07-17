export interface Env {
  DB: D1Database;
  NAS_TOKEN?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUD?: string;
  MEDIA_PUBLIC_BASE_URL?: string;
  MEDIA_BUCKET?: R2Bucket;
}
