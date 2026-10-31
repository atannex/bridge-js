/** Upload progress, reported by transports that can see it (the XHR transport). */
export interface UploadProgress {
  loaded: number;
  /** Undefined when the size is not known. */
  total: number | undefined;
}

/** Bytes of a download read so far. Same shape as upload progress. */
export type DownloadProgress = UploadProgress;

/** One HTTP request, ready to send. Header names are lower-case. */
export interface TransportRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string | FormData | undefined;
  credentials?: RequestCredentials | undefined;
  signal: AbortSignal;
  onUploadProgress?: ((progress: UploadProgress) => void) | undefined;
}

/** What a transport hands back. Only the parts the client reads. */
export interface TransportResponse {
  status: number;
  headers: Headers;
  /** The final URL, when the transport knows it. A different origin than requested means a redirect was followed. */
  url?: string | undefined;
  /** True when the transport followed a redirect. */
  redirected?: boolean | undefined;
  text(): Promise<string>;
}

/**
 * Sends one request. Must reject (with anything) when no response arrived, and
 * must honour `request.signal`. HTTP error statuses are responses, not rejections.
 * The Bridge protocol never redirects: transports should not follow redirects,
 * and must report `url` / `redirected` when they cannot avoid following one.
 */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;
