export interface LockinSession<Level extends string> {
  getThinkingLevel(): Level | undefined;
  setThinkingLevel(level: Level): void;
}

interface TrackedSession<Level extends string> {
  session: LockinSession<Level>;
  baseline?: Level;
  maximumApplied: boolean;
}

export interface LockinOperation {
  changed: boolean;
  enabled: boolean;
  sessions: number;
  updated: number;
  failed: number;
}

/**
 * Process-local lock state shared by every binding of the extension module.
 * It never writes OMP's persistent configuration.
 */
export class LockinController<Level extends string> {
  readonly #maximum: Level;
  readonly #sessions = new Map<symbol, TrackedSession<Level>>();
  #enabled = false;

  constructor(maximum: Level) {
    this.#maximum = maximum;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  register(key: symbol, session: LockinSession<Level>): LockinOperation {
    const existing = this.#sessions.get(key);
    if (existing) this.#restore(existing);

    const tracked: TrackedSession<Level> = {
      session,
      maximumApplied: false,
    };
    this.#sessions.set(key, tracked);

    const outcome = this.#enabled ? this.#apply(tracked) : { updated: 0, failed: 0 };
    return this.#result(false, outcome.updated, outcome.failed);
  }

  unregister(key: symbol, restore = true): LockinOperation {
    const tracked = this.#sessions.get(key);
    if (!tracked) return this.#result(false, 0, 0);

    const outcome = restore ? this.#restore(tracked) : { updated: 0, failed: 0 };
    this.#sessions.delete(key);
    return this.#result(false, outcome.updated, outcome.failed);
  }

  enable(): LockinOperation {
    const changed = !this.#enabled;
    this.#enabled = true;
    const outcome = this.#applyAll();
    return this.#result(changed, outcome.updated, outcome.failed);
  }

  disable(): LockinOperation {
    const changed = this.#enabled;
    this.#enabled = false;
    const outcome = this.#restoreAll();
    return this.#result(changed, outcome.updated, outcome.failed);
  }

  toggle(): LockinOperation {
    return this.#enabled ? this.disable() : this.enable();
  }

  /** Reasserts maximum effort after a model switch or retry fallback. */
  ensure(key: symbol): LockinOperation {
    if (!this.#enabled) return this.#result(false, 0, 0);
    const tracked = this.#sessions.get(key);
    if (!tracked) return this.#result(false, 0, 0);
    const outcome = this.#apply(tracked);
    return this.#result(false, outcome.updated, outcome.failed);
  }

  status(): LockinOperation {
    return this.#result(false, 0, 0);
  }

  #applyAll(): { updated: number; failed: number } {
    let updated = 0;
    let failed = 0;
    for (const tracked of this.#sessions.values()) {
      const outcome = this.#apply(tracked);
      updated += outcome.updated;
      failed += outcome.failed;
    }
    return { updated, failed };
  }

  #restoreAll(): { updated: number; failed: number } {
    let updated = 0;
    let failed = 0;
    for (const tracked of this.#sessions.values()) {
      const outcome = this.#restore(tracked);
      updated += outcome.updated;
      failed += outcome.failed;
    }
    return { updated, failed };
  }

  #apply(tracked: TrackedSession<Level>): { updated: number; failed: number } {
    let updated = 0;
    let failed = 0;

    if (tracked.baseline === undefined) {
      try {
        const baseline = tracked.session.getThinkingLevel();
        // A session without an initialized model cannot be changed safely yet.
        // before_agent_start will retry after model initialization.
        if (baseline === undefined) return { updated, failed };
        tracked.baseline = baseline;
      } catch {
        return { updated, failed: 1 };
      }
    }


    try {
      tracked.session.setThinkingLevel(this.#maximum);
      tracked.maximumApplied = true;
      updated += 1;
    } catch {
      failed += 1;
    }

    return { updated, failed };
  }

  #restore(tracked: TrackedSession<Level>): { updated: number; failed: number } {
    let updated = 0;
    let failed = 0;

    if (tracked.maximumApplied && tracked.baseline !== undefined) {
      try {
        tracked.session.setThinkingLevel(tracked.baseline);
        tracked.maximumApplied = false;
        updated += 1;
      } catch {
        failed += 1;
      }
    }


    if (!tracked.maximumApplied) tracked.baseline = undefined;
    return { updated, failed };
  }

  #result(changed: boolean, updated: number, failed: number): LockinOperation {
    return {
      changed,
      enabled: this.#enabled,
      sessions: this.#sessions.size,
      updated,
      failed,
    };
  }
}
