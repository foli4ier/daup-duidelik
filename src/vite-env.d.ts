/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HOUSE_SEED_URL?: string;
  readonly VITE_REQUIRE_HOUSE_SESSION?: string;
  readonly VITE_AI_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
