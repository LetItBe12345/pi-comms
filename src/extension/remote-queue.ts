import type {
  AgentRequestPayload,
  AgentResultPayload,
} from "../protocol.js";

export class RemoteQueue {
  readonly #queue: AgentRequestPayload[] = [];
  readonly #seenRequestIds = new Set<string>();
  readonly #pendingResults = new Map<string, AgentResultPayload>();
  #activeRequest: AgentRequestPayload | undefined;

  get activeRequest(): AgentRequestPayload | undefined {
    return this.#activeRequest;
  }

  get hasWork(): boolean {
    return this.#activeRequest !== undefined || this.#queue.length > 0;
  }

  enqueue(request: AgentRequestPayload): boolean {
    if (this.#seenRequestIds.has(request.requestId)) {
      return false;
    }
    this.#seenRequestIds.add(request.requestId);
    this.#queue.push(request);
    return true;
  }

  startNext(): AgentRequestPayload | undefined {
    if (this.#activeRequest !== undefined) {
      return undefined;
    }
    this.#activeRequest = this.#queue.shift();
    return this.#activeRequest;
  }

  completeActive(result: AgentResultPayload): void {
    if (this.#activeRequest?.requestId !== result.requestId) {
      return;
    }
    this.#activeRequest = undefined;
    this.#pendingResults.set(result.requestId, result);
  }

  acknowledgeResult(requestId: string): void {
    this.#pendingResults.delete(requestId);
  }

  pendingResults(): AgentResultPayload[] {
    return [...this.#pendingResults.values()];
  }

  clear(): void {
    this.#queue.length = 0;
    this.#seenRequestIds.clear();
    this.#pendingResults.clear();
    this.#activeRequest = undefined;
  }
}
