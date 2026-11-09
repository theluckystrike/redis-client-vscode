# Browse and edit keys

- Expand a connection, then a database. Keys load with SCAN, 10,000 at a time, grouped into folders by ":".
- Right-click a database to filter by pattern (`user:*:session`) and by type, add a key, export or import.
- Click a key to open it. Strings open as text, JSON or hex. Hashes, lists, sets and sorted sets open in a paged grid. Streams show entries newest first, with consumer groups and pending entries.
- The header shows the type, TTL, size and encoding. Click "memory?" for MEMORY USAGE, "TTL…" to set or remove the TTL.
- A key with bytes that are not text shows them as \xNN. Edits go to that exact key.
