/** Transport boundary for DOM tests; messages still travel through the provider. */
export class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  closed = false;
  constructor(url: string | URL) { super(); this.url = String(url); FakeWebSocket.instances.push(this); }
  close() { this.closed = true; }
  /** A text message from the server: `{ type, ...data }` as JSON. */
  emit(type: string, data: object = {}) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type, ...data }) }));
  }
  /** The server or the network ends the socket. */
  drop(code = 1006) {
    this.closed = true;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}
