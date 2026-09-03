export interface Transport {
  readonly selfId: string;
  peers(): readonly string[];
  /** `to` omitted = broadcast to every peer. */
  send(data: string, to?: string): void;
  onMessage(cb: (data: string, from: string) => void): () => void;
  onPeerJoin(cb: (id: string) => void): () => void;
  onPeerLeave(cb: (id: string) => void): () => void;
  leave(): void;
}
