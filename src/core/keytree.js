'use strict';
// Groups loaded keys into folders by a separator (":" by default), like "user:1:name" -> user / 1 / name.
// Keys stay Buffers; folder names are display text. Only the first maxDepth separators make folders.

const { display } = require('./bytes');

class KeyFolder {
  constructor(name, prefix, parent) {
    this.name = name; // display text of this segment
    this.prefix = prefix; // display prefix including the trailing separator
    this.parent = parent;
    this.folders = new Map();
    this.keys = []; // {buf, label, id}
    this.count = 0; // keys below, all levels
  }
}

function buildTree(keys, separator = ':', maxDepth = 12) {
  const root = new KeyFolder('', '', null);
  for (const k of keys) addKey(root, k, separator, maxDepth);
  return root;
}

function addKey(root, buf, separator = ':', maxDepth = 12) {
  const text = display(buf);
  let node = root;
  node.count++;
  if (separator) {
    const parts = text.split(separator);
    const depth = Math.min(parts.length - 1, maxDepth);
    for (let i = 0; i < depth; i++) {
      const seg = parts[i];
      let f = node.folders.get(seg);
      if (!f) { f = new KeyFolder(seg, node.prefix + seg + separator, node); node.folders.set(seg, f); }
      f.count++;
      node = f;
    }
    node.keys.push({ buf, label: parts.slice(depth).join(separator), text });
  } else node.keys.push({ buf, label: text, text });
  return node;
}

/** Sorted children: folders first (by name), then keys (by label); natural order for numbers. */
function children(folder) {
  const cmp = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  const fs = [...folder.folders.values()].sort((a, b) => cmp(a.name, b.name));
  const ks = [...folder.keys].sort((a, b) => cmp(a.label, b.label));
  return { folders: fs, keys: ks };
}

/** A SCAN MATCH pattern for every key below a folder: the prefix with glob characters escaped, then "*". */
function folderPattern(prefix) {
  return prefix.replace(/[*?[\]\\]/g, (c) => '\\' + c) + '*';
}

/** Glob-escape bytes for MATCH (binary safe). */
function escapeGlob(buf) {
  const out = [];
  for (const b of buf) { if (b === 0x2a || b === 0x3f || b === 0x5b || b === 0x5d || b === 0x5c) out.push(0x5c); out.push(b); }
  return Buffer.from(out);
}

module.exports = { buildTree, addKey, children, folderPattern, escapeGlob, KeyFolder };
