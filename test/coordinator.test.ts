import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { LockinCoordinator, type BroadcastResult, type CoordinationAction } from "../src/coordinator.ts";
import type { LockinOperation } from "../src/controller.ts";

// Real child/socket I/O needs real safety deadlines; fake clocks cannot drive another process.

const repoRoot = path.resolve(import.meta.dirname, "..");

const childScript = `
import readline from "node:readline";
import { LockinCoordinator } from "./src/coordinator.ts";
import { LockinController } from "./src/controller.ts";

const registryDir = process.env.REGISTRY_DIR;
const initialLevel = process.env.INITIAL_LEVEL || "medium";

let currentLevel = initialLevel;
const session = {
  getThinkingLevel: () => currentLevel,
  setThinkingLevel: (level) => {
    currentLevel = level;
  },
};

const controller = new LockinController("max");
const key = Symbol("child-session");
controller.register(key, session);

const coordinator = new LockinCoordinator(
  (action) => {
    if (action === "on") return controller.enable();
    if (action === "off") return controller.disable();
    return controller.status();
  },
  { directory: registryDir, timeoutMs: 2000 }
);

await coordinator.start();

const rl = readline.createInterface({ input: process.stdin });
console.log(JSON.stringify({ type: "READY", pid: process.pid }));

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    if (msg.cmd === "GET_LEVEL") {
      console.log(
        JSON.stringify({
          type: "LEVEL",
          level: currentLevel,
          enabled: controller.enabled,
        })
      );
    } else if (msg.cmd === "BROADCAST") {
      const result = await coordinator.broadcast(msg.action);
      console.log(JSON.stringify({ type: "BROADCAST_RESULT", result }));
    } else if (msg.cmd === "STOP") {
      await coordinator.stop();
      console.log(JSON.stringify({ type: "STOPPED" }));
    } else if (msg.cmd === "EXIT") {
      try {
        await coordinator.stop();
      } catch {}
      process.exit(0);
    }
  } catch (err) {
    console.error("Child error handling command:", err);
  }
});
`;

interface ChildReadyMessage {
  type: "READY";
  pid: number;
}

interface ChildLevelMessage {
  type: "LEVEL";
  level: string;
  enabled: boolean;
}

interface ChildBroadcastResultMessage {
  type: "BROADCAST_RESULT";
  result: BroadcastResult;
}

interface ChildStoppedMessage {
  type: "STOPPED";
}

interface ChildExitedMessage {
  type: "CHILD_EXITED";
  code: number | null;
}

type ChildMessage =
  | ChildReadyMessage
  | ChildLevelMessage
  | ChildBroadcastResultMessage
  | ChildStoppedMessage
  | ChildExitedMessage;

interface ChildPeer {
  readonly pid: number;
  getLevel(): Promise<{ level: string; enabled: boolean }>;
  broadcast(action: CoordinationAction): Promise<BroadcastResult>;
  stop(): Promise<void>;
  kill(): Promise<void>;
}

function parseChildMessage(text: string): ChildMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return undefined;
    }
    const candidate = parsed as { type: string };
    if (
      candidate.type === "READY" ||
      candidate.type === "LEVEL" ||
      candidate.type === "BROADCAST_RESULT" ||
      candidate.type === "STOPPED" ||
      candidate.type === "CHILD_EXITED"
    ) {
      return parsed as ChildMessage;
    }
  } catch {
    // Ignore non-JSON child logging
  }
  return undefined;
}

function spawnPeer(registryDir: string, initialLevel: string): Promise<ChildPeer> {
  const { promise, resolve, reject } = Promise.withResolvers<ChildPeer>();

  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      REGISTRY_DIR: registryDir,
      INITIAL_LEVEL: initialLevel,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let ready = false;
  let peerPid = 0;
  let stderr = "";
  const pendingHandlers: Array<(msg: ChildMessage) => void> = [];

  const readyTimeout = setTimeout(() => {
    if (!ready) {
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(new Error(`Timed out waiting for child peer to become ready. Stderr: ${stderr}`));
    }
  }, 10000);

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    const msg = parseChildMessage(text);
    if (!msg) return;

    if (msg.type === "READY") {
      ready = true;
      peerPid = msg.pid;
      clearTimeout(readyTimeout);
      resolve(peer);
    } else if (pendingHandlers.length > 0) {
      const handler = pendingHandlers.shift()!;
      handler(msg);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.on("error", (err) => {
    clearTimeout(readyTimeout);
    if (!ready) reject(err);
  });

  child.on("exit", (code) => {
    clearTimeout(readyTimeout);
    if (!ready) {
      reject(new Error(`Child exited early with code ${code}. Stderr: ${stderr}`));
    }
    while (pendingHandlers.length > 0) {
      const handler = pendingHandlers.shift()!;
      handler({ type: "CHILD_EXITED", code });
    }
  });

  function request<T extends ChildMessage>(
    payload: Record<string, unknown>,
    expectedType: T["type"],
    timeoutMs = 8000
  ): Promise<T> {
    const { promise: reqPromise, resolve: resolveReq, reject: rejectReq } = Promise.withResolvers<T>();

    const timer = setTimeout(() => {
      rejectReq(new Error(`Timed out waiting for ${expectedType} from child pid ${peerPid}`));
    }, timeoutMs);

    pendingHandlers.push((response) => {
      clearTimeout(timer);
      if (response.type === "CHILD_EXITED") {
        rejectReq(new Error(`Child pid ${peerPid} exited unexpectedly with code ${response.code}`));
      } else if (response.type === expectedType) {
        resolveReq(response as T);
      } else {
        rejectReq(new Error(`Unexpected response type ${response.type}, expected ${expectedType}`));
      }
    });

    child.stdin!.write(JSON.stringify(payload) + "\n");
    return reqPromise;
  }

  const peer: ChildPeer = {
    get pid() {
      return peerPid || child.pid || 0;
    },
    async getLevel() {
      const res = await request<ChildLevelMessage>({ cmd: "GET_LEVEL" }, "LEVEL");
      return { level: res.level, enabled: res.enabled };
    },
    async broadcast(action) {
      const res = await request<ChildBroadcastResultMessage>(
        { cmd: "BROADCAST", action },
        "BROADCAST_RESULT",
        10000
      );
      return res.result;
    },
    async stop() {
      await request<ChildStoppedMessage>({ cmd: "STOP" }, "STOPPED");
    },
    async kill() {
      if (child.exitCode !== null || child.killed) return;
      const { promise: killPromise, resolve: resolveKill } = Promise.withResolvers<void>();
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          resolveKill();
        }
      };

      child.once("exit", finish);

      try {
        child.stdin?.destroy();
        child.kill();
      } catch {
        finish();
        return killPromise;
      }

      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish();
      }, 1500);

      child.once("exit", () => {
        clearTimeout(killTimer);
        finish();
      });

      return killPromise;
    },
  };

  return promise;
}

describe("LockinCoordinator", () => {
  test("forces pre-existing children to max, preserves baselines on repeat, aggregates status, and restores on off", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lockin-reg-"));
    const peers: ChildPeer[] = [];
    try {
      const peer1 = await spawnPeer(dir, "low");
      peers.push(peer1);
      const peer2 = await spawnPeer(dir, "medium");
      peers.push(peer2);

      const p1Init = await peer1.getLevel();
      assert.equal(p1Init.level, "low");
      assert.equal(p1Init.enabled, false);

      const p2Init = await peer2.getLevel();
      assert.equal(p2Init.level, "medium");
      assert.equal(p2Init.enabled, false);

      // Broadcast on enables both child processes
      const onResult = await peer1.broadcast("on");
      assert.equal(onResult.unreachable, 0);
      assert.equal(onResult.responses.length, 2);
      assert(onResult.responses.every((r) => r.enabled === true));

      const p1On = await peer1.getLevel();
      assert.equal(p1On.level, "max");
      assert.equal(p1On.enabled, true);

      const p2On = await peer2.getLevel();
      assert.equal(p2On.level, "max");
      assert.equal(p2On.enabled, true);

      // Repeat broadcast on preserves baselines and remains max
      const repeatResult = await peer1.broadcast("on");
      assert.equal(repeatResult.unreachable, 0);
      assert.equal(repeatResult.responses.length, 2);
      assert(repeatResult.responses.every((r) => r.enabled === true && r.changed === false));

      const p1Repeat = await peer1.getLevel();
      assert.equal(p1Repeat.level, "max");
      const p2Repeat = await peer2.getLevel();
      assert.equal(p2Repeat.level, "max");

      // Broadcast status aggregates state across peers
      const statusResult = await peer2.broadcast("status");
      assert.equal(statusResult.unreachable, 0);
      assert.equal(statusResult.responses.length, 2);
      assert(statusResult.responses.every((r) => r.enabled === true));

      // Broadcast off restores each peer to its own baseline
      const offResult = await peer1.broadcast("off");
      assert.equal(offResult.unreachable, 0);
      assert.equal(offResult.responses.length, 2);
      assert(offResult.responses.every((r) => r.enabled === false));

      const p1Off = await peer1.getLevel();
      assert.equal(p1Off.level, "low");
      assert.equal(p1Off.enabled, false);

      const p2Off = await peer2.getLevel();
      assert.equal(p2Off.level, "medium");
      assert.equal(p2Off.enabled, false);
    } finally {
      await Promise.allSettled(peers.map((p) => p.kill()));
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("new terminals started after activation start off", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lockin-reg-"));
    const peers: ChildPeer[] = [];
    try {
      const peer1 = await spawnPeer(dir, "low");
      peers.push(peer1);

      const onResult = await peer1.broadcast("on");
      assert.equal(onResult.responses.length, 1);
      assert.equal((await peer1.getLevel()).level, "max");

      // Spawn new peer after broadcast on
      const peer2 = await spawnPeer(dir, "high");
      peers.push(peer2);

      // Newly started terminal must start OFF
      const p2State = await peer2.getLevel();
      assert.equal(p2State.level, "high");
      assert.equal(p2State.enabled, false);

      const statusResult = await peer1.broadcast("status");
      assert.equal(statusResult.responses.length, 2);
      const enabledCount = statusResult.responses.filter((r) => r.enabled).length;
      assert.equal(enabledCount, 1);
    } finally {
      await Promise.allSettled(peers.map((p) => p.kill()));
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("cleanly stopped peers and dead processes are excluded from broadcast", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lockin-reg-"));
    const peers: ChildPeer[] = [];
    try {
      const peer1 = await spawnPeer(dir, "low");
      peers.push(peer1);
      const peer2 = await spawnPeer(dir, "medium");
      peers.push(peer2);

      const initialStatus = await peer1.broadcast("status");
      assert.equal(initialStatus.responses.length, 2);

      // Cleanly stop peer2 coordinator
      await peer2.stop();

      const afterStopStatus = await peer1.broadcast("status");
      assert.equal(afterStopStatus.responses.length, 1);
      assert.equal(afterStopStatus.unreachable, 0);

      // Spawn peer3 then abruptly kill it
      const peer3 = await spawnPeer(dir, "high");
      peers.push(peer3);

      const withPeer3 = await peer1.broadcast("status");
      assert.equal(withPeer3.responses.length, 2);

      // Abrupt termination: await peer3.kill() waits for real process exit event
      await peer3.kill();

      const afterDeadStatus = await peer1.broadcast("status");
      assert.equal(afterDeadStatus.responses.length, 1);
      assert.equal(afterDeadStatus.unreachable, 0);
    } finally {
      await Promise.allSettled(peers.map((p) => p.kill()));
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("shutdown removes own registry endpoint, start/stop is idempotent and restartable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lockin-reg-"));
    let coordinator: LockinCoordinator | undefined;
    try {
      const dummyHandle = (): LockinOperation => ({
        changed: false,
        enabled: false,
        sessions: 1,
        updated: 0,
        failed: 0,
      });

      coordinator = new LockinCoordinator(dummyHandle, { directory: dir, timeoutMs: 1500 });

      const filesBefore = await fs.readdir(dir);
      assert.equal(filesBefore.filter((f) => f.endsWith(".json")).length, 0);

      await coordinator.start();
      const filesStarted = await fs.readdir(dir);
      assert.equal(filesStarted.filter((f) => f.endsWith(".json")).length, 1);

      // Idempotent start
      await coordinator.start();
      const filesIdempotent = await fs.readdir(dir);
      assert.equal(filesIdempotent.filter((f) => f.endsWith(".json")).length, 1);

      // Stop removes own endpoint
      await coordinator.stop();
      const filesStopped = await fs.readdir(dir);
      assert.equal(filesStopped.filter((f) => f.endsWith(".json")).length, 0);

      // Idempotent stop
      await coordinator.stop();
      const filesDoubleStopped = await fs.readdir(dir);
      assert.equal(filesDoubleStopped.filter((f) => f.endsWith(".json")).length, 0);

      // Restartable
      await coordinator.start();
      const filesRestarted = await fs.readdir(dir);
      assert.equal(filesRestarted.filter((f) => f.endsWith(".json")).length, 1);

      await coordinator.stop();
      const filesFinal = await fs.readdir(dir);
      assert.equal(filesFinal.filter((f) => f.endsWith(".json")).length, 0);
    } finally {
      await coordinator?.stop();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("unresponsive peer deadline reports unreachable without hanging", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lockin-reg-"));
    const sockets = new Set<net.Socket>();
    const dummyServer = net.createServer(socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.resume(); // Deliberately read requests without replying.
    });
    dummyServer.unref();
    const coordinator = new LockinCoordinator(
      () => ({ changed: false, enabled: false, sessions: 1, updated: 0, failed: 0 }),
      { directory: dir, timeoutMs: 300 },
    );
    try {
      const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
      dummyServer.once("error", reject);
      dummyServer.listen(0, "127.0.0.1", resolve);
      await listening;
      const address = dummyServer.address() as net.AddressInfo;
      await fs.writeFile(
        path.join(dir, `${process.pid}-00000000-0000-4000-8000-000000000000.json`),
        JSON.stringify({ version: 1, pid: process.pid, port: address.port, token: "a".repeat(48) }),
      );
      const start = Date.now();
      const result = await coordinator.broadcast("status");
      assert(Date.now() - start < 2500, "Broadcast exceeded its real IPC deadline");
      assert.equal(result.unreachable, 1);
    } finally {
      await coordinator.stop();
      for (const socket of sockets) socket.destroy();
      const { promise: closed, resolve } = Promise.withResolvers<void>();
      dummyServer.close(() => resolve());
      await closed;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects unauthenticated activation without changing a peer's reasoning", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lockin-reg-"));
    const peers: ChildPeer[] = [];
    try {
      // Exercise the live peer's authentication boundary over a real socket.
      const peer = await spawnPeer(dir, "medium");
      peers.push(peer);
      const files = (await fs.readdir(dir)).filter(file => file.endsWith(".json"));
      assert.equal(files.length, 1);
      const endpoint = JSON.parse(await fs.readFile(path.join(dir, files[0]!), "utf8")) as { port: number };

      const { promise: rejected, resolve, reject } = Promise.withResolvers<void>();
      const socket = net.createConnection({ host: "127.0.0.1", port: endpoint.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Unauthenticated connection was not closed"));
      }, 3000);
      socket.on("connect", () => {
        socket.end(JSON.stringify({ version: 1, token: "b".repeat(64), action: "on" }) + "\n");
      });
      socket.resume();
      socket.on("error", reject);
      socket.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      await rejected;
      assert.deepEqual(await peer.getLevel(), { level: "medium", enabled: false });
      const activated = await peer.broadcast("on");
      assert.equal(activated.unreachable, 0);
      assert.equal(activated.responses.length, 1);
      assert.deepEqual(await peer.getLevel(), { level: "max", enabled: true });
    } finally {
      await Promise.allSettled(peers.map(peer => peer.kill()));
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("the latest start wins over an overlapping shutdown", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lockin-reg-"));
    const coordinator = new LockinCoordinator(
      () => ({ changed: false, enabled: false, sessions: 1, updated: 0, failed: 0 }),
      { directory: dir },
    );
    const observer = new LockinCoordinator(
      () => ({ changed: false, enabled: false, sessions: 0, updated: 0, failed: 0 }),
      { directory: dir },
    );
    try {
      await Promise.all([coordinator.start(), coordinator.stop(), coordinator.start()]);
      const result = await observer.broadcast("status");
      assert.equal(result.unreachable, 0);
      assert.equal(result.responses.length, 2);
      assert.equal(result.responses.filter(response => response.sessions === 1).length, 1);
    } finally {
      await Promise.all([coordinator.stop(), observer.stop()]);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("shutdown cancels a pending broadcast before it can activate another process", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lockin-reg-"));
    const coordinator = new LockinCoordinator(
      () => ({ changed: false, enabled: false, sessions: 0, updated: 0, failed: 0 }),
      { directory: dir },
    );
    let peer: ChildPeer | undefined;
    try {
      peer = await spawnPeer(dir, "low");
      await coordinator.start();
      const cancelled = assert.rejects(coordinator.broadcast("on"));
      await coordinator.stop();
      await cancelled;
      assert.deepEqual(await peer.getLevel(), { level: "low", enabled: false });
    } finally {
      await coordinator.stop();
      await peer?.kill();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("discovery never deletes unrecognized or invalid-schema documents", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lockin-reg-"));
    const coordinator = new LockinCoordinator(
      () => ({ changed: false, enabled: false, sessions: 0, updated: 0, failed: 0 }),
      { directory: dir },
    );
    const documents = new Map([
      ["0-not-a-lockin-endpoint.json", "not JSON"],
      ["notes.json", JSON.stringify({ pid: 0 })],
      [`${process.pid}-00000000-0000-4000-8000-000000000001.json`, JSON.stringify({ pid: 0 })],
      ["2147483647-00000000-0000-4000-8000-000000000002.json", "not JSON"],
    ]);
    try {
      for (const [filename, content] of documents) await fs.writeFile(path.join(dir, filename), content);
      const result = await coordinator.broadcast("status");
      assert.equal(result.responses.length, 1);
      assert.equal(result.unreachable, 2);
      for (const [filename, content] of documents) {
        assert.equal(await fs.readFile(path.join(dir, filename), "utf8"), content);
      }
    } finally {
      await coordinator.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
