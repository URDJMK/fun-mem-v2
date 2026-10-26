/**
 * Stands in, in the Worker bundle only (wrangler.toml [alias]), for an optional package that is
 * not installed: posthog-node (through @mastra/core) imports `@opentelemetry/api` if it is there,
 * inside a try that falls back when it is not. On Node that import fails and the fallback runs;
 * the bundler needs a module to resolve, and this empty one makes the same fallback run.
 */
export {};
