import type { ExecutionMode } from './signal.js';

export type SystemEventLevel = 'debug' | 'info' | 'warning' | 'error' | 'critical';

export type SystemEventCategory =
  | 'market_data'
  | 'analysis'
  | 'signal'
  | 'risk'
  | 'simulation'
  | 'backtest'
  | 'auth'
  | 'api'
  | 'ai'
  | 'system';

/**
 * One shape for everything that gets logged, audited or shown on the health
 * panel. Persisted to `system_events`.
 */
export interface SystemEvent {
  readonly id: string;
  readonly at: number;
  readonly level: SystemEventLevel;
  readonly category: SystemEventCategory;
  /** Stable machine code, e.g. 'provider_disconnected'. */
  readonly code: string;
  readonly message: string;
  readonly executionMode: ExecutionMode | null;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

export type ServiceHealth = 'ok' | 'degraded' | 'unavailable' | 'not_configured';

export interface ComponentStatus {
  readonly component: string;
  readonly health: ServiceHealth;
  readonly detail: string;
}

export interface SystemStatus {
  readonly service: string;
  readonly version: string;
  readonly startedAt: number;
  readonly uptimeSeconds: number;
  readonly executionMode: ExecutionMode;
  readonly liveTradingEnabled: boolean;
  readonly components: readonly ComponentStatus[];
}
