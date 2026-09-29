import { APWError, DATA_PATH, SOCKET_PATH, Status } from "./const.ts";
import { type Browser, installSearchBridge, launchBrowser, SEARCH, searchBridgeInstalled } from "./browser.ts";
import { readConfig, writeConfig } from "./config.ts";
import type { APWResponse, Message } from "./types.ts";

const REQUEST_TIMEOUT_MS = 30_000;

type ExtensionMessage = APWResponse | { token: string };

interface Pending {
  id: string;
  resolve: (value: APWResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class ExtensionSession {
  private ws: WebSocket | null = null;
  private pending: Pending | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private token: string) {}

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = null;
  }

  accept(ws: WebSocket): void {
    ws.addEventListener("message", (event) => {
      let message: ExtensionMessage;
      try {
        message = JSON.parse(event.data as string);
      } catch {
        ws.close(4002, "Bad JSON");
        return;
      }

      if (this.ws !== ws) {
        if (!("token" in message) || message.token !== this.token) {
          ws.close(4003, "Unauthorized");
          return;
        }
        const previous = this.ws;
        this.ws = ws;
        previous?.close(4001, "Replaced by a newer connection");
        console.info("[apw] extension connected");
        return;
      }

      if (!("token" in message) && this.pending?.id === message.id) {
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        pending.resolve(message as APWResponse);
      }
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.rejectPending(new Error("Extension disconnected"));
      console.info("[apw] extension disconnected");
    });
  }

  request(message: Message): Promise<APWResponse> {
    const result = this.chain.then(() => {
      const ws = this.ws;
      if (!ws) throw new APWError(Status.INVALID_SESSION);
      return new Promise<APWResponse>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(
          () => this.rejectPending(new Error("Extension response timed out")),
          REQUEST_TIMEOUT_MS,
        );
        this.pending = { id, resolve, reject, timer };
        ws.send(JSON.stringify({ ...message, id }));
      });
    });
    this.chain = result.catch(() => {});
    return result;
  }
}

async function handleCliConnection(
  conn: Deno.Conn,
  session: { request(message: Message): Promise<APWResponse> },
): Promise<void> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const buf = new Uint8Array(1024 * 64);
  let text = "";
  const send = async (response: APWResponse) => {
    try {
      await conn.write(encoder.encode(`${JSON.stringify(response)}\n`));
    } catch (e) {
      if ((e as { code?: string }).code !== "EPIPE") throw e;
    }
  };

  try {
    const deadline = setTimeout(() => conn.close(), REQUEST_TIMEOUT_MS);
    try {
      while (!text.includes("\n")) {
        const n = await conn.read(buf);
        if (n === null) break;
        text += decoder.decode(buf.subarray(0, n));
        if (text.length > 1024 * 1024) break;
      }
    } finally {
      clearTimeout(deadline);
    }

    try {
      const message = JSON.parse(text.split("\n", 1)[0]) as Message;
      if (typeof message.cmd !== "number") {
        throw new APWError(Status.INVALID_PARAM);
      }
      await send(await session.request(message));
    } catch (error) {
      const err = error as Error;
      await send({
        id: "",
        status: err instanceof APWError ? err.status : Status.SERVER_ERROR,
        error: err.message,
      });
    }
  } finally {
    conn.close();
  }
}

export async function daemon(browser: Browser): Promise<void> {
  Deno.mkdirSync(DATA_PATH, { recursive: true, mode: 0o700 });
  Deno.chmodSync(DATA_PATH, 0o700);

  const hosted = browser.id === SEARCH.id;
  const bridge = hosted ? stableBridge() : { port: 0, token: crypto.randomUUID() };
  const token = bridge.token;
  const session = new ExtensionSession(token);

  const wsServer = Deno.serve({ hostname: "127.0.0.1", port: bridge.port }, (req) => {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    session.accept(socket);
    return response;
  });

  const child = hosted ? null : await launchBrowser(browser, { port: (wsServer.addr as Deno.NetAddr).port, token });
  if (hosted) {
    ensureSearchBridge(bridge);
  } else {
    console.info(`[apw] launched headless ${browser.name}; extension loaded.`);
  }
  const shutdown = async () => {
    try {
      child?.kill("SIGTERM");
      await child?.status;
    } catch { /* ignore */ }
    Deno.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) Deno.addSignalListener(signal, shutdown);

  try {
    Deno.removeSync(SOCKET_PATH);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const unixListener = Deno.listen({ transport: "unix", path: SOCKET_PATH });
  console.info(`[apw] Unix socket at ${SOCKET_PATH}`);
  await Deno.chmod(SOCKET_PATH, 0o600);

  for await (const conn of unixListener) {
    handleCliConnection(conn, session).catch(console.error);
  }
}

function stableBridge(): { port: number; token: string } {
  const { bridgePort, bridgeToken } = readConfig();
  if (bridgePort && bridgeToken) return { port: bridgePort, token: bridgeToken };
  const bridge = { port: 20000 + Math.floor(Math.random() * 10000), token: crypto.randomUUID() };
  writeConfig({ bridgePort: bridge.port, bridgeToken: bridge.token });
  return bridge;
}

function ensureSearchBridge(bridge: { port: number; token: string }): void {
  if (searchBridgeInstalled(bridge)) return;
  installSearchBridge(bridge);
  console.info("[apw] bridge installed into Search's iCloud Passwords extension; quit and reopen Search to load it");
}
