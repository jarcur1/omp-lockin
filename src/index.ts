import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { LockinController, type LockinOperation, type LockinSession } from "./controller.ts";
import { LockinCoordinator, type BroadcastResult, type CoordinationAction } from "./coordinator.ts";

const maximumThinkingLevel = "max" as ThinkingLevel;
const controller = new LockinController<ThinkingLevel>(maximumThinkingLevel);
const coordinator = new LockinCoordinator(action => {
  if (action === "on") return controller.enable();
  if (action === "off") return controller.disable();
  return controller.status();
});

function notificationFor(action: string, result: LockinOperation): string {
  if (action === "status") {
    return `Lock-in is ${result.enabled ? "ON" : "OFF"}; tracking ${result.sessions} live workflow session${result.sessions === 1 ? "" : "s"}.`;
  }

  const state = result.enabled ? "ON" : "OFF";
  const transition = result.changed ? `Lock-in ${state}` : `Lock-in is already ${state}`;
  const behavior = result.enabled
    ? `maximum reasoning requested for ${result.sessions} live workflow session${result.sessions === 1 ? "" : "s"}`
    : `normal reasoning restored for ${result.sessions} live workflow session${result.sessions === 1 ? "" : "s"}`;
  const failures = result.failed > 0 ? ` ${result.failed} update${result.failed === 1 ? "" : "s"} failed; see OMP logs.` : "";
  return `${transition}: ${behavior}.${failures}`;
}

function notificationForAll(action: CoordinationAction, result: BroadcastResult): string {
  const terminals = result.responses.length;
  const sessions = result.responses.reduce((sum, response) => sum + response.sessions, 0);
  const failed = result.responses.reduce((sum, response) => sum + response.failed, 0);
  const enabled = result.responses.filter(response => response.enabled).length;
  const scope = `${sessions} live workflow session${sessions === 1 ? "" : "s"} across ${terminals} reachable OMP terminal${terminals === 1 ? "" : "s"}`;
  const message = action === "status"
    ? `Lock-in is ON in ${enabled} of ${terminals} reachable OMP terminals; tracking ${sessions} live workflow sessions.`
    : `${action === "on" ? "Maximum reasoning requested" : "Normal reasoning restored"} for ${scope}.`;
  const failures = failed > 0 ? ` ${failed} session update${failed === 1 ? "" : "s"} failed; see OMP logs.` : "";
  const unreachable = result.unreachable > 0
    ? ` ${result.unreachable} terminal${result.unreachable === 1 ? "" : "s"} could not be reached; not all terminals were updated.`
    : "";
  return `${message}${failures}${unreachable}`;
}

export default function lockinExtension(pi: ExtensionAPI): void {

  pi.setLabel("Lock In");

  const key = Symbol("omp-lockin-session");
  let attached = false;

  const session: LockinSession<ThinkingLevel> = {
    getThinkingLevel: () => pi.getThinkingLevel(),
    setThinkingLevel: level => pi.setThinkingLevel(level),
  };

  const attach = (): LockinOperation => {
    if (attached) return controller.ensure(key);
    attached = true;
    return controller.register(key, session);
  };

  const detach = (): LockinOperation => {
    if (!attached) return controller.status();
    attached = false;
    return controller.unregister(key, true);
  };

  const startCoordination = async (): Promise<void> => {
    try {
      await coordinator.start();
    } catch (error) {
      pi.logger.warn("Lock-in cross-terminal coordination unavailable", { error: String(error) });
    }
  };

  pi.on("session_start", async () => {
    attach();
    await startCoordination();
  });

  pi.on("session_before_switch", () => {
    detach();
  });

  pi.on("session_switch", async () => {
    attach();
    await startCoordination();
  });

  pi.on("session_shutdown", async () => {
    detach();
    if (controller.sessionCount === 0) await coordinator.stop();
  });

  pi.on("before_agent_start", () => {
    attach();
    controller.ensure(key);
  });

  pi.on("retry_fallback_applied", () => {
    controller.ensure(key);
  });

  pi.registerCommand("lockin", {
    description: "Toggle maximum reasoning locally; use all [on|off|status] across OMP terminals",
    handler: async (rawArgs, ctx) => {
      attach();
      const action = rawArgs.trim().toLowerCase();
      const all = /^all(?:\s+(on|off|status))?$/.exec(action);
      if (all) {
        const allAction = (all[1] ?? "on") as CoordinationAction;
        try {
          const result = await coordinator.broadcast(allAction);
          const failed = result.unreachable > 0 || result.responses.some(response => response.failed > 0);
          ctx.ui.notify(notificationForAll(allAction, result), failed ? "warning" : "info");
        } catch (error) {
          pi.logger.warn("Lock-in cross-terminal command failed", { error: String(error) });
          ctx.ui.notify("Cross-terminal lock-in failed; see OMP logs. Other terminals may not have been updated.", "error");
        }
        return;
      }
      let result: LockinOperation;

      if (action === "") {
        result = controller.toggle();
      } else if (action === "on") {
        result = controller.enable();
      } else if (action === "off") {
        result = controller.disable();
      } else if (action === "status") {
        result = controller.status();
      } else {
        ctx.ui.notify("Usage: /lockin [on|off|status|all [on|off|status]]", "error");
        return;
      }

      ctx.ui.notify(notificationFor(action || "toggle", result), result.failed > 0 ? "warning" : "info");
    },
  });
}
