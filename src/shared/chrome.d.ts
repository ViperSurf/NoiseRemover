/**
 * Minimal WebExtensions typings used by this project.
 * Kept local so the extension has zero runtime dependencies and the build
 * needs nothing beyond esbuild + typescript (dev only).
 */
declare namespace chrome {
  namespace storage {
    interface StorageArea {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get(keys?: any): Promise<Record<string, any>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
  }
  namespace runtime {
    const lastError: { message?: string } | undefined;
    function getURL(path: string): string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function sendMessage(message: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onMessage: { addListener(fn: (msg: any, sender: any, sendResponse: (response?: any) => void) => boolean | void): void };
    function connect(options?: { name: string }): Port;
    const onConnect: { addListener(fn: (port: Port) => void): void };
    function getContexts(filter: { contextTypes: ContextType[] }): Promise<unknown[]>;
    enum ContextType { OFFSCREEN_DOCUMENT = 'OFFSCREEN_DOCUMENT' }
    interface Port {
      name: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      postMessage(message: any): void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onMessage: { addListener(fn: (msg: any) => void): void };
      onDisconnect: { addListener(fn: () => void): void };
    }
  }
  namespace tabCapture {
    function getMediaStreamId(options: { targetTabId: number }, callback: (streamId: string) => void): void;
  }
  namespace offscreen {
    enum Reason { USER_MEDIA = 'USER_MEDIA', AUDIO_PLAYBACK = 'AUDIO_PLAYBACK' }
    function createDocument(options: { url: string; reasons: Reason[]; justification: string }): Promise<void>;
  }
  namespace tabs {
    interface Tab { id?: number; url?: string; title?: string; audible?: boolean }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function sendMessage(tabId: number, message: any): Promise<any>;
    const onRemoved: { addListener(fn: (tabId: number) => void): void };
  }
  namespace scripting {
    function executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  }
  namespace action {
    function setBadgeText(options: { tabId: number; text: string }): Promise<void>;
    function setBadgeBackgroundColor(options: { tabId: number; color: string }): Promise<void>;
  }
  namespace commands {
    const onCommand: { addListener(fn: (command: string) => void): void };
  }
}
