/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute origin of the API when the UI is hosted separately, e.g. https://api.example.com */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
