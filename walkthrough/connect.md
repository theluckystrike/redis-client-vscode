# Connect

- Single node: host, port, optional user (Redis 6+ ACL) and password, database number.
- Cluster: one or more nodes as `host:port`. The client finds the rest and routes each key to its node.
- Sentinel: the sentinels (often port 26379) and the primary name from `sentinel monitor <name>`. After a failover the client follows the new primary.
- TLS: tick TLS (or paste a `rediss://` URL). Pick the CA file of a private or self-signed server.

A failed connection says which step failed: DNS, TCP, TLS or AUTH, with a hint.

Tick Read-only for a production server: writes are refused before they reach it.
