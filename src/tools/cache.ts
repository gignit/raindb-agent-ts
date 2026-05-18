// cache.ts -- agent tools for object-cache observability.
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_cache.go::tenantCacheTools.
// Admin variants (cache_stats_tenant, cache_stats_all) are NOT
// ported here -- those are admin-scoped and belong in a separate
// admin tool catalog if/when one ships.

import { executeGraphQL } from '../client/graphql.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes (mirror internal/ops/cache.go::CacheStatsRow)
// ---------------------------------------------------------------------------

interface HostCacheRow {
  hostKey: string;
  addr: string;
  role: string;
  realmName: string;
  error?: string;
  stats?: CacheStatsRow;
}

export interface CacheStatsRow {
  tenantId: string;
  maxBytes: number;
  currentBytes: number;
  itemCount: number;
  hitCount: number;
  missCount: number;
  hitRatio: number;
  evictionCount: number;
  bytesReadFromS3: number;
  bytesEvicted: number;
  avgItemSize: number;
  lastUpdated?: number;
  hosts?: HostCacheRow[];
}

interface MyCacheStatsResponse {
  myCacheStats: CacheStatsRow | null;
}

// Selection set mirrors internal/ops/queries.go::cacheStatsFields. Stay
// in lockstep when the Go side changes; the parity gate is the test
// in test/unit/cache_stats_my.test.ts.
const MY_CACHE_STATS_QUERY = `
  query MyCacheStats {
    myCacheStats {
      tenantId
      maxBytes
      currentBytes
      itemCount
      hitCount
      missCount
      hitRatio
      evictionCount
      bytesReadFromS3
      bytesEvicted
      avgItemSize
      lastUpdated
      hosts {
        hostKey
        addr
        role
        realmName
        error
        stats {
          tenantId
          maxBytes
          currentBytes
          itemCount
          hitCount
          missCount
          hitRatio
          evictionCount
          bytesReadFromS3
          bytesEvicted
          avgItemSize
          lastUpdated
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// cache_stats_my -- Go ref: tools_cache.go::tenantCacheTools (lines 16-31)
//   + ops/cache.go::GetMyCacheStats (lines 163-174)
// ---------------------------------------------------------------------------

export const cache_stats_my: RegisteredTool = {
  name: 'cache_stats_my',
  description:
    'Object-cache stats for the current tenant (items, bytes, hit ratio). '
    + 'Equivalent CLI: raindb-cli cache stats',
  minRole: 'read',
  parameters: { type: 'object' },
  async execute(ctx) {
    const data = await executeGraphQL<MyCacheStatsResponse>(
      MY_CACHE_STATS_QUERY,
      {},
      ctx.creds,
      ctx.host,
    );
    // Go side returns an empty CacheStatsRow when myCacheStats is null
    // (ops/cache.go:170-172). Mirror that so callers get a stable shape.
    return data.myCacheStats ?? ({
      tenantId: '',
      maxBytes: 0,
      currentBytes: 0,
      itemCount: 0,
      hitCount: 0,
      missCount: 0,
      hitRatio: 0,
      evictionCount: 0,
      bytesReadFromS3: 0,
      bytesEvicted: 0,
      avgItemSize: 0,
    } satisfies CacheStatsRow);
  },
};

export const cacheTools: RegisteredTool[] = [cache_stats_my];
