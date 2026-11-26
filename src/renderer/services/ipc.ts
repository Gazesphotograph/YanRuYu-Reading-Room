import type {
  ElectronFunctionBridge,
  EventChannel,
  EventChannelMap,
  InvokeChannel,
  InvokeChannelMap,
  PreloadIpcRenderer,
} from '../types/ipc';

type AnyEventListener = (payload: unknown) => void;

export interface ElectronZoomController {
  get(): number;
  set(level: number): void;
  insertCss(css: string): Promise<string> | string | undefined;
}

const channelListeners = new Map<EventChannel, Set<AnyEventListener>>();
const boundBridgeByChannel = new Map<EventChannel, PreloadIpcRenderer>();

let overrideBridge: PreloadIpcRenderer | null | undefined;
let overrideElectronFunction: ElectronFunctionBridge | null | undefined;

function getWindowObject(): Window | undefined {
  return typeof globalThis !== 'undefined' && 'window' in globalThis
    ? (globalThis as { window?: Window }).window
    : undefined;
}

function getIpcBridge(): PreloadIpcRenderer | undefined {
  if (overrideBridge !== undefined) {
    return overrideBridge ?? undefined;
  }
  return getWindowObject()?.ipcRenderer;
}

function getElectronFunctionBridge(): ElectronFunctionBridge | undefined {
  if (overrideElectronFunction !== undefined) {
    return overrideElectronFunction ?? undefined;
  }
  return getWindowObject()?.electronFunction;
}

export function setIpcBridgeForTesting(
  bridge: PreloadIpcRenderer | null | undefined,
  electronFn?: ElectronFunctionBridge | null | undefined
): void {
  overrideBridge = bridge;
  if (electronFn !== undefined) {
    overrideElectronFunction = electronFn;
  }
  boundBridgeByChannel.clear();
}

export function resetIpcSubscriptions(): void {
  channelListeners.clear();
  boundBridgeByChannel.clear();
}

export function hasIpc(): boolean {
  const bridge = getIpcBridge();
  return typeof bridge?.invoke === 'function';
}

export async function invoke<K extends InvokeChannel>(
  channel: K,
  ...args: InvokeChannelMap[K]['args']
): Promise<InvokeChannelMap[K]['result']> {
  const bridge = getIpcBridge();
  if (!bridge || typeof bridge.invoke !== 'function') {
    throw new Error(`IPC bridge is unavailable for channel "${channel}"`);
  }
  return bridge.invoke(channel, ...args);
}

function ensureChannelBound(channel: EventChannel): void {
  const bridge = getIpcBridge();
  if (!bridge || typeof bridge.on !== 'function') return;
  if (boundBridgeByChannel.get(channel) === bridge) return;

  boundBridgeByChannel.set(channel, bridge);
  bridge.on(channel, (_event: null, payload: EventChannelMap[typeof channel]) => {
    const subscribers = channelListeners.get(channel);
    if (!subscribers || subscribers.size === 0) return;
    for (const listener of [...subscribers]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`IPC event listener failed for "${channel}":`, error);
      }
    }
  });
}

/**
 * Subscribe to a preload IPC event channel.
 *
 * Preload's `ipcRenderer.on` keeps a single listener per channel, so this wrapper
 * multiplexes each channel across any number of renderer subscribers and returns
 * an unsubscribe function.
 */
export function onEvent<K extends EventChannel>(
  channel: K,
  listener: (payload: EventChannelMap[K]) => void
): () => void {
  let subscribers = channelListeners.get(channel);
  if (!subscribers) {
    subscribers = new Set();
    channelListeners.set(channel, subscribers);
  }
  const wrapped = listener as AnyEventListener;
  subscribers.add(wrapped);
  ensureChannelBound(channel);

  return () => {
    const current = channelListeners.get(channel);
    if (!current) return;
    current.delete(wrapped);
  };
}

export function getPathSep(): string {
  const bridge = getIpcBridge();
  if (bridge && typeof bridge.sendSync === 'function') {
    try {
      const sep = bridge.sendSync('get-path-sep');
      if (sep === '/' || sep === '\\') return sep;
    } catch {
      // Fallback safely in preview or test environments.
    }
  }
  return '/';
}

export function electronZoom(): ElectronZoomController {
  return {
    get(): number {
      const bridge = getElectronFunctionBridge();
      if (bridge && typeof bridge['get-zoom-level'] === 'function') {
        try {
          const level = bridge['get-zoom-level']();
          return Number.isFinite(level) ? level : 0;
        } catch {
          return 0;
        }
      }
      return 0;
    },
    set(level: number): void {
      if (!Number.isFinite(level)) return;
      const bridge = getElectronFunctionBridge();
      if (bridge && typeof bridge['set-zoom-level'] === 'function') {
        bridge['set-zoom-level'](level);
      }
    },
    insertCss(css: string): Promise<string> | string | undefined {
      const bridge = getElectronFunctionBridge();
      if (bridge && typeof bridge['insert-css'] === 'function') {
        return bridge['insert-css'](css);
      }
      return undefined;
    },
  };
}
