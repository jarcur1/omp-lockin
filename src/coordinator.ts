import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { LockinOperation } from "./controller.ts";

export type CoordinationAction = "on" | "off" | "status";

export interface BroadcastResult {
  responses: LockinOperation[];
  unreachable: number;
}

export interface LockinCoordinatorOptions {
  directory?: string;
  timeoutMs?: number;
}

const endpointFilePattern = /^([1-9]\d*)-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.json$/i;

interface EndpointQueryResult {
  status: "ok" | "stale" | "unreachable";
  operation?: LockinOperation;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function isValidLockinOperation(val: unknown): val is LockinOperation {
  if (typeof val !== "object" || val === null) {
    return false;
  }
  return (
    "changed" in val &&
    typeof val.changed === "boolean" &&
    "enabled" in val &&
    typeof val.enabled === "boolean" &&
    "sessions" in val &&
    typeof val.sessions === "number" &&
    Number.isInteger(val.sessions) &&
    val.sessions >= 0 &&
    "updated" in val &&
    typeof val.updated === "number" &&
    Number.isInteger(val.updated) &&
    val.updated >= 0 &&
    "failed" in val &&
    typeof val.failed === "number" &&
    Number.isInteger(val.failed) &&
    val.failed >= 0
  );
}

export class LockinCoordinator {
  readonly #handle: (action: CoordinationAction) => LockinOperation;
  readonly #directory: string;
  readonly #timeoutMs: number;
  readonly #activeSockets = new Set<net.Socket>();

  #running = false;
  #generation = 0;
  #lifecycle: Promise<void> = Promise.resolve();
  #server?: net.Server;
  #token?: string;
  #endpointPath?: string;

  constructor(
    handle: (action: CoordinationAction) => LockinOperation,
    options?: LockinCoordinatorOptions,
  ) {
    this.#handle = handle;
    this.#directory = path.resolve(options?.directory ?? path.join(os.homedir(), ".omp", "lockin"));
    this.#timeoutMs = typeof options?.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : 1500;
  }

  start(): Promise<void> {
    const transition = this.#lifecycle.then(async () => {
      if (this.#running) return;
      await this.#doStart();
      this.#running = true;
    });
    this.#lifecycle = transition.catch(() => {});
    return transition;
  }

  stop(): Promise<void> {
    // Invalidate discovery immediately, before awaiting earlier lifecycle work.
    this.#generation += 1;
    const transition = this.#lifecycle.then(async () => {
      this.#running = false;
      await this.#doStop();
    });
    this.#lifecycle = transition.catch(() => {});
    return transition;
  }

  #assertActive(generation: number): void {
    if (!this.#running || generation !== this.#generation) {
      throw new Error("Cross-terminal coordination stopped during broadcast");
    }
  }

  async broadcast(action: CoordinationAction): Promise<BroadcastResult> {
    const generation = this.#generation;
    await this.start();
    this.#assertActive(generation);

    const entries = await fs.readdir(this.#directory, { withFileTypes: true });
    this.#assertActive(generation);
    const endpointFiles = entries
      .filter(entry => entry.isFile() && endpointFilePattern.test(entry.name))
      .map((e) => path.join(this.#directory, e.name));

    const queryResults = await Promise.all(
      endpointFiles.map(file => this.#queryEndpoint(file, action, generation)),
    );
    this.#assertActive(generation);

    const responses: LockinOperation[] = [];
    let unreachable = 0;

    for (const res of queryResults) {
      if (res.status === "ok" && res.operation) {
        responses.push(res.operation);
      } else if (res.status === "unreachable") {
        unreachable += 1;
      }
    }

    return { responses, unreachable };
  }

  async #ensureDirectory(): Promise<void> {
    const dir = this.#directory;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink()) {
      throw new Error(`Insecure coordinator directory: "${dir}" is a symbolic link`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Insecure coordinator directory: "${dir}" is not a directory`);
    }

    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error(`Insecure coordinator directory: "${dir}" is owned by foreign uid ${stat.uid}`);
      }

      if ((stat.mode & 0o077) !== 0) {
        await fs.chmod(dir, 0o700);
        const recheck = await fs.stat(dir);
        if ((recheck.mode & 0o077) !== 0) {
          throw new Error(`Insecure coordinator directory: failed to enforce owner-private permissions on "${dir}"`);
        }
      }
    }
  }

  async #doStart(): Promise<void> {
    await this.#ensureDirectory();

    const server = net.createServer((socket) => {
      this.#handleIncomingConnection(socket);
    });
    server.unref();
    this.#server = server;

    let stagedPath: string | undefined;

    try {
      const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      const onError = (error: unknown) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(0, "127.0.0.1");
      await listening;

      server.on("error", () => {
        // Prevent unhandled server error event after listening
      });

      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Coordinator server failed to bind to a local TCP port");
      }
      const port = addr.port;
      const token = crypto.randomBytes(24).toString("hex");

      this.#token = token;

      const id = crypto.randomUUID();
      const filename = `${process.pid}-${id}.json`;
      const stagedName = `.${process.pid}-${id}.tmp`;
      const endpointPath = path.join(this.#directory, filename);
      stagedPath = path.join(this.#directory, stagedName);

      const payload = JSON.stringify({
        version: 1,
        pid: process.pid,
        port,
        token,
      });

      const writeOptions = process.platform !== "win32" ? { mode: 0o600 } : undefined;
      await fs.writeFile(stagedPath, payload, writeOptions);
      await fs.rename(stagedPath, endpointPath);
      this.#endpointPath = endpointPath;
    } catch (err: unknown) {
      if (stagedPath) {
        await fs.unlink(stagedPath).catch(() => {});
      }
      await this.#doStop();
      throw err;
    }
  }

  async #doStop(): Promise<void> {
    if (this.#endpointPath) {
      const endpoint = this.#endpointPath;
      this.#endpointPath = undefined;
      await fs.unlink(endpoint).catch(() => {});
    }

    for (const socket of this.#activeSockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.#activeSockets.clear();

    if (this.#server) {
      const server = this.#server;
      this.#server = undefined;
      const { promise: closed, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await closed;
    }

    this.#token = undefined;
  }

  #handleIncomingConnection(socket: net.Socket): void {
    this.#activeSockets.add(socket);
    socket.unref();

    let handled = false;
    // An absolute deadline also bounds clients that trickle bytes indefinitely.
    const deadline = setTimeout(() => socket.destroy(), this.#timeoutMs);
    deadline.unref();

    const cleanupSocket = () => {
      this.#activeSockets.delete(socket);
      clearTimeout(deadline);
    };
    socket.once("close", cleanupSocket);
    socket.once("error", cleanupSocket);

    let buffer = "";
    const MAX_BUFFER = 16384;

    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_BUFFER) {
        socket.destroy();
        return;
      }

      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      handled = true;

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = "";

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        socket.end(JSON.stringify({ version: 1, error: "Invalid JSON" }) + "\n");
        return;
      }

      if (typeof parsed !== "object" || parsed === null) {
        socket.end(JSON.stringify({ version: 1, error: "Invalid request payload" }) + "\n");
        return;
      }

      if (!("version" in parsed) || !("action" in parsed) || !("token" in parsed)) {
        socket.end(JSON.stringify({ version: 1, error: "Missing required request fields" }) + "\n");
        return;
      }

      if (parsed.version !== 1) {
        socket.end(JSON.stringify({ version: 1, error: "Unsupported protocol version" }) + "\n");
        return;
      }

      if (parsed.action !== "on" && parsed.action !== "off" && parsed.action !== "status") {
        socket.end(JSON.stringify({ version: 1, error: "Invalid action" }) + "\n");
        return;
      }

      if (typeof parsed.token !== "string" || !this.#token) {
        socket.end(JSON.stringify({ version: 1, error: "Unauthorized" }) + "\n");
        return;
      }

      const reqTokenBuf = Buffer.from(parsed.token, "utf8");
      const ownTokenBuf = Buffer.from(this.#token, "utf8");
      if (reqTokenBuf.length !== ownTokenBuf.length || !crypto.timingSafeEqual(reqTokenBuf, ownTokenBuf)) {
        socket.end(JSON.stringify({ version: 1, error: "Unauthorized" }) + "\n");
        return;
      }

      try {
        const result = this.#handle(parsed.action);
        socket.end(JSON.stringify({ version: 1, result }) + "\n");
      } catch {
        socket.end(JSON.stringify({ version: 1, error: "Internal handler error" }) + "\n");
      }
    });
  }

  async #queryEndpoint(filePath: string, action: CoordinationAction, generation: number): Promise<EndpointQueryResult> {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "stale" : "unreachable" };
    }
    if (!this.#running || generation !== this.#generation) return { status: "unreachable" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // An unrecognized document is never safe to delete based on its name alone.
      return { status: "unreachable" };
    }

    if (typeof parsed !== "object" || parsed === null) {
      return { status: "unreachable" };
    }

    if (!("version" in parsed) || !("pid" in parsed) || !("port" in parsed) || !("token" in parsed)) {
      return { status: "unreachable" };
    }

    const { version, pid, port, token } = parsed;

    if (
      version !== 1 ||
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      Number(endpointFilePattern.exec(path.basename(filePath))?.[1]) !== pid ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65535 ||
      typeof token !== "string" ||
      !token
    ) {
      return { status: "unreachable" };
    }

    if (!isPidAlive(pid)) {
      await fs.unlink(filePath).catch(() => {});
      return { status: "stale" };
    }
    if (!this.#running || generation !== this.#generation) return { status: "unreachable" };

    const { promise, resolve } = Promise.withResolvers<EndpointQueryResult>();
    let settled = false;
    let socket: net.Socket | undefined;
    let buffer = "";
    const finish = (result: EndpointQueryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        this.#activeSockets.delete(socket);
        socket.destroy();
      }
      resolve(result);
    };
    // Active broadcasts keep their socket/deadline referenced until acknowledged.
    const timer = setTimeout(() => finish({ status: "unreachable" }), this.#timeoutMs);
    try {
      socket = net.connect({ host: "127.0.0.1", port });
    } catch {
      finish({ status: "unreachable" });
      return promise;
    }
    this.#activeSockets.add(socket);
    socket.once("connect", () => {
      socket?.write(JSON.stringify({ version: 1, token, action }) + "\n");
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > 16384) {
        finish({ status: "unreachable" });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const reply: unknown = JSON.parse(buffer.slice(0, newline));
        if (
          typeof reply === "object" && reply !== null &&
          "version" in reply && reply.version === 1 &&
          "result" in reply && isValidLockinOperation(reply.result)
        ) {
          finish({ status: "ok", operation: reply.result });
          return;
        }
      } catch {
        // Invalid replies are failed acknowledgements, never successful updates.
      }
      finish({ status: "unreachable" });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        // Settle before asynchronous cleanup: close may fire before unlink completes.
        finish({ status: "stale" });
        void fs.unlink(filePath).catch(() => {});
      } else {
        finish({ status: "unreachable" });
      }
    });
    socket.once("close", () => finish({ status: "unreachable" }));
    return promise;
  }
}
