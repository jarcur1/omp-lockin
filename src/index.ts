import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { LockinController, type LockinOperation, type LockinSession } from "./controller.ts";

const maximumThinkingLevel = "max" as ThinkingLevel;
const controller = new LockinController<ThinkingLevel>(maximumThinkingLevel);

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

  pi.on("session_start", () => {
    attach();
  });

  pi.on("session_before_switch", () => {
    detach();
  });

  pi.on("session_switch", () => {
    attach();
  });

  pi.on("session_shutdown", () => {
    detach();
  });

  pi.on("before_agent_start", () => {
    attach();
    controller.ensure(key);
  });

  pi.on("retry_fallback_applied", () => {
    controller.ensure(key);
  });

  pi.registerCommand("lockin", {
    description: "Toggle maximum reasoning across the active OMP workflow",
    handler: async (rawArgs, ctx) => {
      attach();
      const action = rawArgs.trim().toLowerCase();
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
        ctx.ui.notify("Usage: /lockin [on|off|status]", "error");
        return;
      }

      ctx.ui.notify(notificationFor(action || "toggle", result), result.failed > 0 ? "warning" : "info");
    },
  });
}
