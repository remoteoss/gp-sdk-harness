/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COMPANY_ID: string;
  /** 'proxy' (Mode B, default) or 'direct' (Mode A experiment). */
  readonly VITE_AUTH_MODE?: 'proxy' | 'direct';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
