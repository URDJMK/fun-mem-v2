export const PACKAGE_NAME = '@funmem/api';

export { createApp, type App, type AppDeps } from './app';
export { supabaseAuth, type AuthConfig, type AuthVariables } from './auth';
export { drainOnce, startEmbeddingLoop } from './embeddings';
export { createBgeM3Provider, defaultModelCacheDir, type RealProvider } from './embeddings-real';
