export interface Env {
  DB: D1Database;
  NAS_TOKEN?: string;
  ADMIN_TOKEN?: string;
  MEDIA_PUBLIC_BASE_URL?: string;
  MEDIA_BUCKET?: R2Bucket;
}
