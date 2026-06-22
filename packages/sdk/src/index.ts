export interface BonfireClientOptions {
  baseUrl: string;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
