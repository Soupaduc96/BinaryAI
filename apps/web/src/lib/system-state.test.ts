import { describe, expect, it } from 'vitest';
import type { SystemStatus } from '@binaryai/types';
import type { ApiResult } from '@/lib/api';
import {
  apiIndicator,
  componentIndicator,
  marketDataIndicator,
  marketIndicator,
} from './system-state';

/**
 * These tests exist because every indicator in the shell resolves through this
 * module, and the failure mode it guards against is not a crash — it is a
 * plausible-looking lie. A dashboard that reports OFFLINE for a healthy server,
 * or LIVE for a stale feed, is worse than one that reports nothing: it is
 * confidently wrong, and an operator acts on it.
 *
 * So the assertions below are mostly about DISTINCTIONS being preserved rather
 * than about any particular string. Collapsing two states into one is the bug.
 */

function failure(partial: {
  error: string;
  status?: number;
  unauthorized?: boolean;
}): ApiResult<SystemStatus> {
  return { ok: false, ...partial };
}

function statusWith(component: string, health: string, detail = 'detail'): ApiResult<SystemStatus> {
  return {
    ok: true,
    data: {
      version: '0.1.0',
      uptimeSeconds: 10,
      components: [{ component, health, detail }],
    } as unknown as SystemStatus,
  };
}

describe('apiIndicator', () => {
  it('reports ONLINE when the API answers', () => {
    const indicator = apiIndicator(statusWith('api', 'ok'));
    expect(indicator.value).toBe('ONLINE');
    expect(indicator.tone).toBe('ok');
  });

  it('reports LOCKED, not OFFLINE, for 401 and 403', () => {
    for (const status of [401, 403]) {
      const indicator = apiIndicator(
        failure({ error: 'Unauthorized', status, unauthorized: true }),
      );
      expect(indicator.value).toBe('LOCKED');
      // A refusal to answer THIS session is not an outage, so it must not be
      // toned as a fault.
      expect(indicator.tone).not.toBe('bad');
    }
  });

  it('reports ERROR, not OFFLINE, for a 5xx', () => {
    // The server is up. Something behind it is not, and the distinction is the
    // difference between restarting a process and investigating a dependency.
    const indicator = apiIndicator(failure({ error: 'Internal', status: 500 }));
    expect(indicator.value).toBe('ERROR');
    expect(indicator.detail).toContain('500');
  });

  it('reports THROTTLED, not ERROR, for a 429', () => {
    const indicator = apiIndicator(failure({ error: 'Too many requests', status: 429 }));
    expect(indicator.value).toBe('THROTTLED');
    // A rate limiter doing its job is not a fault.
    expect(indicator.tone).toBe('warn');
  });

  it('reports OFFLINE only when nothing answered at all', () => {
    const indicator = apiIndicator(failure({ error: 'fetch failed' }));
    expect(indicator.value).toBe('OFFLINE');
  });

  it('never reports OFFLINE for any response that carried a status code', () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
      expect(apiIndicator(failure({ error: 'x', status })).value).not.toBe('OFFLINE');
    }
  });
});

describe('marketDataIndicator', () => {
  it('keeps NOT CONFIGURED distinct from DISCONNECTED', () => {
    // "Never set up" and "set up and broken" call for different actions.
    expect(marketDataIndicator(statusWith('market_data', 'not_configured')).value).toBe(
      'NOT CONFIGURED',
    );
    expect(marketDataIndicator(statusWith('market_data', 'unavailable')).value).toBe(
      'DISCONNECTED',
    );
  });

  it('does not report a degraded feed as LIVE', () => {
    // A stale feed HAS data, which is what makes showing it as live dangerous.
    const indicator = marketDataIndicator(statusWith('market_data', 'degraded'));
    expect(indicator.value).toBe('DEGRADED');
    expect(indicator.value).not.toBe('LIVE');
  });

  it('reports UNKNOWN rather than inventing a state when the API is unreachable', () => {
    expect(marketDataIndicator(failure({ error: 'fetch failed' })).value).toBe('UNKNOWN');
  });

  it('surfaces the API detail string rather than a written-for-display one', () => {
    expect(marketDataIndicator(statusWith('market_data', 'ok', 'provider ok')).detail).toBe(
      'provider ok',
    );
  });

  it('reports UNKNOWN when the component is absent entirely', () => {
    // Absence is not health. Defaulting a missing component to "ok" would be
    // the single most dangerous shortcut in this file.
    expect(marketDataIndicator(statusWith('api', 'ok')).value).toBe('UNKNOWN');
  });
});

describe('marketIndicator', () => {
  it('is LIVE only when market data is actually live', () => {
    expect(marketIndicator(statusWith('market_data', 'ok')).value).toBe('LIVE');
    expect(marketIndicator(statusWith('market_data', 'not_configured')).value).toBe('WAITING');
    expect(marketIndicator(statusWith('market_data', 'unavailable')).value).toBe('WAITING');
  });

  it('reports DELAYED for a degraded feed', () => {
    expect(marketIndicator(statusWith('market_data', 'degraded')).value).toBe('DELAYED');
  });
});

describe('componentIndicator', () => {
  it('does not treat an unrecognised health value as healthy', () => {
    const indicator = componentIndicator('something-new', 'detail');
    expect(indicator.value).toBe('UNKNOWN');
    expect(indicator.tone).not.toBe('ok');
  });

  it('distinguishes not_configured from unavailable', () => {
    expect(componentIndicator('not_configured', '').value).toBe('NOT CONFIGURED');
    expect(componentIndicator('unavailable', '').value).toBe('UNAVAILABLE');
  });
});
