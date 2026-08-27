/**
 * @binaryai/config -- the single place environment variables are read and
 * validated. Import `loadConfig` rather than touching `process.env`.
 */

export {
  loadConfig,
  describeConfig,
  envSchema,
  ConfigError,
  type AppConfig,
  type Env,
} from './env.js';
