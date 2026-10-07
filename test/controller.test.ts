import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LockinController, type LockinSession } from "../src/controller.ts";

type Level = "off" | "low" | "medium" | "high" | "xhigh" | "max";

interface FakeSession extends LockinSession<Level> {
  level: Level | undefined;
  defaultLevel: Level;
  thinkingWrites: Level[];
}

function fakeSession(level: Level | undefined, defaultLevel: Level = "high"): FakeSession {
  const session: FakeSession = {
    level,
    defaultLevel,
    thinkingWrites: [],
    getThinkingLevel() {
      return session.level;
    },
    setThinkingLevel(next) {
      session.level = next;
      session.thinkingWrites.push(next);
    },
  };
  return session;
}

describe("LockinController", () => {
  test("leaves registered sessions at normal reasoning until enabled", () => {
    const controller = new LockinController<Level>("max");
    const session = fakeSession("medium");

    controller.register(Symbol("main"), session);

    assert.equal(controller.enabled, false);
    assert.equal(session.level, "medium");
    assert.equal(session.defaultLevel, "high");
    assert.deepEqual(session.thinkingWrites, []);
  });

  test("forces all live sessions to max and restores each baseline", () => {
    const controller = new LockinController<Level>("max");
    const main = fakeSession("medium", "medium");
    const child = fakeSession("xhigh", "high");
    controller.register(Symbol("main"), main);
    controller.register(Symbol("child"), child);

    const enabled = controller.enable();

    assert.equal(enabled.changed, true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.sessions, 2);
    assert.equal(enabled.failed, 0);
    assert.equal(main.level, "max");
    assert.equal(child.level, "max");
    assert.equal(main.defaultLevel, "medium");
    assert.equal(child.defaultLevel, "high");

    const disabled = controller.disable();

    assert.equal(disabled.changed, true);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.sessions, 2);
    assert.equal(disabled.failed, 0);
    assert.equal(main.level, "medium");
    assert.equal(child.level, "xhigh");
    assert.equal(main.defaultLevel, "medium");
    assert.equal(child.defaultLevel, "high");
  });

  test("does not replace the baseline on repeated enable commands", () => {
    const controller = new LockinController<Level>("max");
    const session = fakeSession("low");
    controller.register(Symbol("main"), session);

    controller.enable();
    const repeated = controller.enable();
    controller.disable();

    assert.equal(repeated.changed, false);
    assert.equal(session.level, "low");
    assert.equal(session.defaultLevel, "high");
  });

  test("locks sessions registered after activation", () => {
    const controller = new LockinController<Level>("max");
    controller.enable();
    const child = fakeSession("high");

    controller.register(Symbol("late-child"), child);

    assert.equal(child.level, "max");
    controller.disable();
    assert.equal(child.level, "high");
  });

  test("reasserts max after an external model switch without losing the baseline", () => {
    const controller = new LockinController<Level>("max");
    const key = Symbol("main");
    const session = fakeSession("medium");
    controller.register(key, session);
    controller.enable();

    session.level = "low";
    controller.ensure(key);

    assert.equal(session.level, "max");
    controller.disable();
    assert.equal(session.level, "medium");
  });

  test("waits for model initialization before capturing a baseline", () => {
    const controller = new LockinController<Level>("max");
    const key = Symbol("starting");
    const session = fakeSession(undefined);
    controller.register(key, session);

    controller.enable();
    assert.deepEqual(session.thinkingWrites, []);

    session.level = "xhigh";
    controller.ensure(key);
    assert.equal(session.level, "max");

    controller.disable();
    assert.equal(session.level, "xhigh");
  });

  test("restores a session when it shuts down while lock-in remains enabled", () => {
    const controller = new LockinController<Level>("max");
    const key = Symbol("child");
    const child = fakeSession("high");
    controller.register(key, child);
    controller.enable();

    const removed = controller.unregister(key, true);

    assert.equal(removed.failed, 0);
    assert.equal(controller.enabled, true);
    assert.equal(controller.sessionCount, 0);
    assert.equal(child.level, "high");
    assert.equal(child.defaultLevel, "high");
  });
});
