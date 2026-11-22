# Bounded pagination

The website replaces the visible page rather than appending results. People:12/page; Office Review:10/page; marketplace Tasks:12/page. Previous/Next retain a chain snapshot; search, rank/status filters and explicit refresh start at page1. The header counts remain global totals rather than page counts.

## Office reads

- GET /api/office?summary=1 returns global stats and optional wallet membership/today data, without the full employee or assignment lists. Legacy callers without summary retain the existing response.
- GET /api/people?offset=0&limit=12&q=&rank=All returns employees,total,offset,limit,nextOffset,readBlock. Search and rank apply globally on the server before paging. Rank accepts All or0..4. employeeNumber is the original1-based registration position, independent of rank, search and page; avatar identity therefore does not shift.
- GET /api/assignments?offset=0&limit=10&view=all returns assignments,total,pendingTotal,offset,limit,nextOffset,readBlock. Views:all,pending,mine (mine requires address). Full report text, Agent ID and current rank are loaded only for the selected page. Existing API clients may request up to50; UI always requests10.
- Supply the returned block as block=N on subsequent pages. Expired/evicted Office snapshots return409 SNAPSHOT_EXPIRED; refresh starts a new snapshot. Invalid/future blocks and malformed filters return400.

## Marketplace reads

- GET /api/marketplace?limit=12 supports offset,block,q,phase. matchedTasks is the exact filtered total; totalTasks is the entire escrow count. UI never treats the unfiltered count as the filtered count. nextOffset is treated as an opaque server cursor, with history for Previous.
- An unfiltered page reads only its selected tasks. A filtered query uses a bounded cached public index with hash-verified public metadata, never private artifacts.
- INDEX_BUILDING returns503 with readBlock and Retry-After; retry at that same snapshot rather than submitting transactions. No generation, model call or payment is required to list pages.

## Indexing limits

The deployed contracts do not provide global accepted-work/name/status indexes. A cold global index necessarily reads O(total) public records once. Office builds at most25 People or50 Review metadata rows/request; shared Redis checkpoints survive serverless cold starts. Selected Review evidence is not retained in the index. People/Review snapshots are retained up to5minutes across four fixed slots per kind; collisions can evict earlier. New unpinned Office snapshots refresh after15seconds.

Marketplace filtered indexes are shared by deployment/block across search/phase queries and expire after5minutes. Unpinned filtered requests reuse a deployment-scoped recent block for15seconds across advancing chain heads; explicit pinned requests remain unchanged. They are bounded to8slots,8MiB/index and10,000tasks, with bounded32MiB process memory. Office indexes are bounded to20,000rows and8MiB. Exceeding capacity is explicit, not silent truncation. Without configured Redis the fallback is process-local; fresh serverless instances must rebuild.

Office automatically retries a progressing cold index with a deadline and bounded attempts, then offers Continue loading from its checkpoint. Marketplace offers a pinned Retry action. A completed warm index is reused for page/filter requests; the browser receives only the requested rows. This is not a claim that a cold global search over arbitrary chain history costs only one page of RPCs.

## Verification

Synthetic1,000-record fixtures exercise People12, Review10 and Tasks12, server/global filters, immutable registration IDs, snapshot pinning, Previous/Next replacement, race cancellation, invalid responses, expiry, checkpoint resumption and lease fencing. Fixtures are local tests only; they do not create public members, tasks, payments or eligibility evidence. Browser checks cover320,390,768,1280px with bounded DOM row counts. Existing animation/performance regression tests remain in the release gate.
