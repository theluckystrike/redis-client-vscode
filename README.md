# Redis Client & Redis GUI for VS Code (Redis Viewer for Keys, TTL, Streams, Cluster and Sentinel)

**Free, no sign-in, no telemetry. The extension talks only to the Redis servers you add.** Works with Redis, Valkey and KeyDB, on a single node, a cluster or a sentinel set, with TLS and ACL users.

![The Redis Explorer with keys grouped by prefix, and a hash open in the key editor](images/screenshot-dark.png)

- Key tree: keys load with `SCAN` in pages (never `KEYS *`), grouped into folders by `:`. Filter by pattern and by type. A database with a million keys stays responsive.
- Editors for every type: strings (text, JSON view, hex for binary values), hashes, lists, sets and sorted sets in a paged grid, streams with consumer groups and pending entries, RedisJSON documents. Add, edit, delete (with a question first) and rename. Set or remove the TTL.
- Binary safe: keys and values stay bytes from the server to the editor and back. A key with bytes that are not text shows as `\xNN` and every write goes to that exact key.
- Big values: a string over 5 MB opens as a size message with "Show the first 64 KB" and "Save to a file", never a frozen editor. Collections load 200 rows at a time.
- Cluster and Sentinel: list the cluster nodes, or the sentinels and the primary name. After a failover the client follows the new primary.
- Clear errors: a failed connection names the step: DNS, TCP, TLS or AUTH, with a hint. No "Something was wrong".
- Console with history (↑ ↓) and Tab completion of command names. `FLUSHALL`, `FLUSHDB`, `KEYS`, `DEBUG` and `SHUTDOWN` ask first.
- Server info: memory, hit rate, keyspace, every `INFO` section, the slow log and connected clients, per node in a cluster.
- Pub/Sub: subscribe to a channel or a pattern and watch messages arrive live; publish a test message.
- Export and import: keys matching a pattern to JSON and back, binary safe, with TTLs.
- Read-only switch per connection: writes are refused before they reach the server.
- Remote SSH and Dev Containers: the extension runs where your workspace runs, so a Redis inside the container or on the remote network is reachable as `localhost` or by its service name.

Redis is a registered trademark of Redis Ltd. This extension is not made by, affiliated with or endorsed by Redis Ltd.

## Get started

1. Click the Redis icon in the activity bar, then Add Connection.
2. Paste a URL (`redis://user:password@host:6379/0`, `rediss://…` for TLS, `redis+sentinel://host:26379/mymaster`) or fill in the form. Test connection shows each step.
3. Expand the connection and a database, then click a key.

Right-click a connection for the console, server info and pub/sub. Right-click a database or a folder to filter, add a key, export or import.

## Why this one

Recent reviews of the most installed Redis extensions for VS Code name these problems (quotes from the Marketplace review pages):

| Review | What this extension does |
|---|---|
| "Doesn't support Redis-Sentinel. Doesn't support Redis-Cluster" ([Redis for VS Code reviews](https://marketplace.visualstudio.com/items?itemName=Redis.redis-for-vscode&ssr=false#review-details), Oct 2026) | Connects to a cluster (keys are scanned on every primary) and through sentinels, and follows a failover. |
| "Doesn't support remote development (SSH, DevContainers, Tunnels, etc.) … You just get an error message that says 'Something was wrong!'" (same page, Mar 2025) | Runs in the remote extension host, and every error names the step that failed. |
| "nags you to sign up for the cloud service" (same page, Oct 2025) | No account, no sign-up prompt, no cloud service. |
| "A paid Redis client in 2022 is just an awful idea" ([Redis by cweijan reviews](https://marketplace.visualstudio.com/items?itemName=cweijan.vscode-redis-client&ssr=false#review-details)) | Every feature above is free. Two extra tools are Zovo Pro (below), each with 3 free tries. |

It is also on [Open VSX](https://open-vsx.org/extension/zovo/zovo-redis-client) for Cursor, Windsurf and VSCodium.

## Zovo Pro (optional)

Two tools for people who run Redis in production. Each can be tried 3 times for free; nothing else changes.

- Memory Analysis: samples keys with `MEMORY USAGE` and shows the biggest keys, the key patterns that use the most memory (`user:*:session`) and the memory by type. Open the report as Markdown.
- Bulk TTL / Delete by Pattern: set a TTL on, remove the TTL of, or delete every key that matches a pattern. A dry run lists the matching keys first; nothing changes until you confirm.

Zovo Pro is USD 19 once and unlocks the Pro tools in every Zovo extension: GitHub Sponsors (the "$19 one time" tier) or PayPal with a license key. Hide the Pro tools with the setting `redisClient.showProFeatures`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `redisClient.scanPageSize` | 10000 | Keys loaded into the tree per page |
| `redisClient.pageSize` | 200 | Rows per page in the collection and stream editors |
| `redisClient.maxValueSizeMB` | 5 | Larger strings open as a size message |
| `redisClient.connectTimeoutSeconds` | 10 | Connection time limit |
| `redisClient.showProFeatures` | true | Show the two Zovo Pro tools |
| `redisClient.askForRating` | true | One rating question after 2 good sessions |

## Privacy and network

- Connections go only to the hosts you add. Nothing connects when VS Code starts; a connection opens when you expand it.
- Passwords are kept in VS Code's secret storage. Connection settings (without passwords) are kept in VS Code's global storage on this computer.
- No telemetry, no analytics, no account. The Zovo Pro unlock asks GitHub one question, only after you click Unlock.

## Support Zovo

Zovo extensions are free, with no ads and no tracking. They are made by [theluckystrike](https://github.com/theluckystrike) on GitHub. If this one saves you time, you can support the work:

- [Sponsor on GitHub](https://github.com/sponsors/theluckystrike)
- [PayPal](https://www.paypal.com/paypalme/najzzz)
- [Follow theluckystrike on GitHub](https://github.com/theluckystrike)

### Need your format supported?

Open a [format request](https://github.com/theluckystrike/redis-client-vscode/issues/new?template=format-request.yml) with a sample file, and I reply there whether it can be done. For USD 299 once, through [this GitHub Sponsors tier](https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679995), I add your file format or a missing feature to this extension, with tests, within 7 days.

## More tools by Zovo

- [Postgres & MySQL Query Client - SQL Database Tool (SQLite, CSV Export)](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-sql-client) Free PostgreSQL client and MySQL client for VS Code: unlimited connections, edit rows, streamed CSV export. Run SQL with Ctrl+Enter, browse tables, cancel long queries. Also MariaDB and SQLite. No sign-in, no telemetry, no keep-alive queries.
- [Large JSON Viewer, JSON Browser & JSON Tree](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-json-tree-viewer) shows large JSON files as a searchable tree, copies JSONPath and turns arrays of objects into a table.
- [JSONL Viewer, Large JSONL Table & NDJSON Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-jsonl-viewer) opens JSONL and NDJSON files as a table, as records or as a chat view.
- [SQLite Viewer & SQLite3 DB File Browser, Database Explorer](https://marketplace.visualstudio.com/items?itemName=zovo.sqlite-table-viewer) browses SQLite tables read-only and runs SELECT queries.
- [GeoJSON Viewer, KML Viewer & GPX Viewer (Map Preview, Shapefile)](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-geo-map-viewer) GeoJSON viewer, KML viewer and GPX viewer with a map preview in VS Code. Also opens shapefiles (SHP, zipped), KMZ, TopoJSON, WKT and CSV with lat/lon: feature table, properties, GPX distance and elevation profile, reprojection from .prj, PNG export. Free, no sign-in, works offline.

See [all Zovo extensions on the Marketplace](https://marketplace.visualstudio.com/publishers/zovo).

## More from zovo

- [All free zovo VS Code extensions](https://marketplace.visualstudio.com/publishers/zovo) — file viewers, database clients, formatters. Offline, no telemetry, no sign-up.
- [Full MCP server catalogue](https://theluckystrike.github.io/mcp/) — local-first MCP servers for back-office work: invoices, VAT, PDFs, spreadsheets, payroll.
- [Hosted no-install MCP endpoints](https://mcp.zovo.one) — paste a URL in Claude / Cursor, nothing to install.
