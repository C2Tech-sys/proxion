/**
 * `@novnc/novnc` ships no published types. As of 1.7.x its `exports` map only exposes the
 * package root ("." -> "./core/rfb.js"), so `import RFB from '@novnc/novnc'` (not a deep
 * `/core/rfb.js` import, which `exports` blocks) is how VncConsole.tsx reaches the RFB class.
 * This pins the small surface it actually uses. See `node_modules/@novnc/novnc/core/rfb.js`
 * and `docs/API.md` in the package for the full API.
 */
declare module '@novnc/novnc' {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);

    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;

    disconnect(): void;
    sendCredentials(credentials: RFBCredentials): void;
    sendCtrlAltDel(): void;
    machineShutdown(): void;
    machineReboot(): void;
    machineReset(): void;
    clipboardPasteFrom(text: string): void;
  }
}
