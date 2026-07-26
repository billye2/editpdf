// The editing engine runs in a Web Worker; this is the viewer's only handle
// to it. Everything geometry- or PDF-mutating goes through this proxy.

import * as Comlink from 'comlink';
import type { EngineAPI } from '../shared/types';

const engineWorker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
export const engine = Comlink.wrap<EngineAPI>(engineWorker);

// Ship the bundled look-alike fallback fonts (Gelasio for serif docs,
// Liberation Sans for sans — see public/fonts/fallback/) to the engine.
// Fire-and-forget: if any fetch fails the engine simply keeps its built-in
// standard-14 fallbacks.
const FALLBACK_FILES: Record<string, string> = {
  'serif-regular': 'Gelasio-Regular.ttf',
  'serif-bold': 'Gelasio-Bold.ttf',
  'serif-italic': 'Gelasio-Italic.ttf',
  'serif-bolditalic': 'Gelasio-BoldItalic.ttf',
  'sans-regular': 'LiberationSans-Regular.ttf',
  'sans-bold': 'LiberationSans-Bold.ttf',
  'sans-italic': 'LiberationSans-Italic.ttf',
  'sans-bolditalic': 'LiberationSans-BoldItalic.ttf',
};

void (async () => {
  const entries = await Promise.all(
    Object.entries(FALLBACK_FILES).map(async ([key, file]) => {
      const resp = await fetch(`fonts/fallback/${file}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return [key, new Uint8Array(await resp.arrayBuffer())] as const;
    }),
  );
  await engine.registerFallbackFonts(Object.fromEntries(entries));
})().catch(() => {});
