// Builds stage3d.min.js: the 3D people (src3d/stage3d.js) with only the parts of three.js, GLTFLoader, SkeletonUtils
// and the meshopt decoder they use, tree-shaken and minified into one file that the page loads lazily after the room
// picture is on screen.  Run `npm run build` after editing anything in src3d/ or concept-calib.js, then commit the output
// (test/perf.test.mjs fails when the bundle is older than its sources).
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sourceHash } from './src-hash.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hash = sourceHash();
  const r = await build({
    entryPoints: [join(root, 'src3d/stage3d.js')], bundle: true, minify: true, format: 'esm', target: 'es2020', write: false, legalComments: 'none',
    banner: { js: `/* stage3d.min.js · src ${hash} · three.js r170 (MIT), GLTFLoader/SkeletonUtils (MIT), meshoptimizer decoder (MIT) · built from src3d/ with scripts/build-stage.mjs */` },
  });
  writeFileSync(join(root, 'stage3d.min.js'), r.outputFiles[0].contents);
  console.log('stage3d.min.js', r.outputFiles[0].contents.length, 'bytes, src', hash);
}
