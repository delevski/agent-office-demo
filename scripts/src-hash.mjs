// Hash of everything stage3d.min.js is built from (src3d/ and the calibration), so a test can tell a stale bundle.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
export function sourceHash() {
  const files = [];
  const walk = d => { for (const f of readdirSync(d).sort()) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(join(root, 'src3d')); files.push(join(root, 'concept-calib.js'));
  const h = createHash('sha256');
  for (const f of files) { h.update(relative(root, f)); h.update(readFileSync(f)); }
  return h.digest('hex').slice(0, 16);
}
