// The native interface (room-entry.js and everything it imports) still lives in
// resources/app/dist beside this bundle. It is loaded at runtime from its own
// URL instead of being bundled, so its relative imports, top-level await and the
// dynamic classic-manager import keep working byte for byte.
//
// The path is assembled at runtime on purpose: a literal `new URL('…', import.meta.url)`
// would make Vite try to resolve and copy the file as a build asset.
const LEGACY_ENTRY = ['..', 'room-entry.js'].join('/');

export function startLegacyInterface(): Promise<unknown> {
  const url = new URL(LEGACY_ENTRY, import.meta.url).href;
  return import(/* @vite-ignore */ url);
}
