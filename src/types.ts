export interface AppDependencies {
  fetch: typeof fetch;
  now: () => Date;
}

export type ExecutionDependencies = AppDependencies;

export interface RequestContext {
  requestId: string;
  startedAt: number;
  /** End-user authentication completion; request-local timing only. */
  authCompletedAt?: number;
  userId?: string;
  apiKeyId?: string;
  sessionId?: string;
  threadId?: string;
}
