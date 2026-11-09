export type RelayEnv = {
  MAC_TOKEN: string;
  IPHONE_TOKEN: string;
  WATCH_TOKEN: string;
  NTFY_URL?: string;
  NTFY_TOPIC?: string;
  /** Cursor Cloud Agents API key. Basic-auth user. Never logged. */
  CURSOR_API_KEY?: string;
};
