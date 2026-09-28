import { ensureBuildRoot } from '../../src/services/compiler.js';

/*
 * A vitest setup file (vitest.config.ts `setupFiles`): create the build root the way the server
 * does — `0700`, verified — before any test file's helpers run. Many helpers stage a "compiled"
 * PDF with `mkdir(dirname(buildPdfPath(...)), { recursive: true })`, and whichever of them ran
 * first used to create the root with the process umask. Under umask 022 that root was merely
 * readable and `ensureBuildRoot` tightened it; under umask 002 (the default for a user-private
 * group on many Linux distributions) it is group-WRITABLE, which `ensureBuildRoot` refuses rather
 * than tightens (#215), and every PDF tool in the run would then fail on the refusal. A test that
 * points TMPDIR elsewhere gets a fresh root of its own and is unaffected.
 */
await ensureBuildRoot();
