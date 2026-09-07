import {
  ConductorApi, ConductorApiError,
  type ConductorAvailability, type ConductorControlStatus, type ConductorControlUpdate,
  type ConductorResponse, type ConductorSceneUpdate, type ConductorWalkingPath,
} from "../../../apps/livemap/src/conductor-api.js";
import type { ConductorArtViewV1 } from "../../../apps/livemap/src/conductor-renderer.js";
import type { ConductorCommandV1, ConductorSessionSnapshotV1 } from "../../../packages/runtime-native/src/session-types.js";

/** JSON transport only. All state transitions and decisions belong to the original Rust kernels. */
export type OfflineInvoke = (command: string, input: unknown) => unknown | Promise<unknown>;
export interface OfflineContext {
  readonly worldId: string;
  readonly operatorId: string;
  readonly trainRunId: string;
  readonly fixtureHash: string;
}
export interface OfflineNativeResult {
  readonly context: OfflineContext;
  readonly checkpoint: unknown;
  readonly availability: ConductorAvailability;
  readonly response: ConductorResponse | null;
  readonly report: ConductorControlStatus;
}
export interface OfflineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface OfflineVisibility {
  isVisible(): boolean;
  subscribe(changed: () => void): () => void;
}
export interface OfflineApiOptions {
  readonly invoke: OfflineInvoke;
  /** Private checkpoint JSON is serialized by the worker, never by the UI. */
  readonly exportSave?: () => Promise<string>;
  readonly fixture: unknown;
  readonly art: ConductorArtViewV1;
  readonly atlases: Readonly<Record<string, string>>;
  readonly storage?: OfflineStorage | null;
  readonly storageKey?: string;
  readonly clock?: () => number;
  readonly visibility?: OfflineVisibility;
  readonly pulseMs?: number;
}
export interface OfflineDemoSession {
  readonly api: ConductorApi;
  readonly context: OfflineContext;
  readonly persistence: { readonly available: boolean; readonly restored: boolean; readonly message: string | null };
  reset(): Promise<void>;
  flushSave(): Promise<void>;
  dispose(): void;
}
type StreamValue = ConductorResponse | ConductorSessionSnapshotV1 | ConductorSceneUpdate | ConductorControlUpdate;
type Listener = { readonly receive: (value: StreamValue) => void; readonly reject: (reason: unknown) => void };
const SAVE_SCHEMA = "conductor-offline-save/v1";
const MAX_SAVE_LENGTH = 32 * 1024 * 1024;
// The original Rust boundary accepts at most 60 seconds per transition. An
// interrupted local practice session resumes without catching up paused time.
const MAX_CONTINUOUS_CLOCK_MS = 60_000;

function browserVisibility(): OfflineVisibility {
  if (typeof document === "undefined") return { isVisible: () => true, subscribe: () => () => {} };
  return {
    isVisible: () => document.visibilityState !== "hidden",
    subscribe: (changed) => {
      document.addEventListener("visibilitychange", changed);
      return () => document.removeEventListener("visibilitychange", changed);
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw failure("offline_transport_invalid");
  return value as Record<string, unknown>;
}
function failure(code: string, message = "Der lokale Rust-Kern konnte diesen Schritt nicht bestätigen."): ConductorApiError {
  return new ConductorApiError(code.includes("stale") ? 409 : 503, code, message);
}
function copy<T>(value: T): T { return structuredClone(value); }
function validateContext(value: unknown): OfflineContext {
  const row = object(value);
  for (const name of ["worldId", "operatorId", "trainRunId", "fixtureHash"]) {
    if (typeof row[name] !== "string" || row[name].length === 0 || row[name].length > 200) throw failure("offline_context_invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(row.fixtureHash as string)) throw failure("offline_context_invalid");
  return row as unknown as OfflineContext;
}
function sameContext(left: OfflineContext, right: OfflineContext): boolean {
  return left.worldId === right.worldId && left.operatorId === right.operatorId
    && left.trainRunId === right.trainRunId && left.fixtureHash === right.fixtureHash;
}
function validateReport(value: unknown, context: OfflineContext): ConductorControlStatus {
  const row = object(value);
  if (row.schemaVersion !== "conductor-control-status/v1" || !Array.isArray(row.cases) || !Array.isArray(row.days)
    || row.cases.some((item) => object(item).trainRunId !== context.trainRunId)) throw failure("offline_report_binding_mismatch");
  return value as ConductorControlStatus;
}
function validateResult(value: unknown, expected?: OfflineContext): OfflineNativeResult {
  const row = object(value), context = validateContext(row.context), available = object(row.availability);
  if (expected !== undefined && !sameContext(context, expected)) throw failure("offline_fixture_mismatch");
  if (!Object.hasOwn(row, "checkpoint") || available.available !== true
    || !Number.isSafeInteger(available.revision) || Number(available.revision) < 0
    || !Number.isSafeInteger(available.manifestRevision) || Number(available.manifestRevision) < 0
    || !(available.sessionId === null || typeof available.sessionId === "string")) throw failure("offline_transport_invalid");
  if (row.response !== null) {
    const response = object(row.response), snapshot = object(response.snapshot), layout = object(response.layout), pins = object(snapshot.pins);
    if (response.schemaVersion !== "conductor-session-response/v1" || snapshot.schemaVersion !== "conductor-session-snapshot/v1"
      || snapshot.worldId !== context.worldId || snapshot.operatorId !== context.operatorId || snapshot.trainRunId !== context.trainRunId
      || layout.layoutHash !== pins.interiorLayoutHash) throw failure("offline_response_binding_mismatch");
    if (response.control !== null && response.control !== undefined) validateReport(response.control, context);
    if (response.scene !== null && response.scene !== undefined) {
      const binding = object(object(response.scene).binding);
      if (binding.worldId !== context.worldId || binding.trainRunId !== context.trainRunId) throw failure("offline_scene_binding_mismatch");
    }
  }
  validateReport(row.report, context);
  return value as OfflineNativeResult;
}
function validateArtBinding(result: OfflineNativeResult, art: ConductorArtViewV1): void {
  if (result.response === null) return;
  const { layout, snapshot, scene } = result.response;
  if (layout.binding.artReleaseId !== art.releaseId || layout.binding.artManifestHash !== art.manifestSha256
    || snapshot.passengers.sourceLayoutHash !== layout.layoutHash
    || (scene !== null && scene !== undefined && (scene.binding.artReleaseId !== art.releaseId
      || scene.binding.artManifestHash !== art.manifestSha256))) throw failure("offline_art_binding_mismatch");
}

/** Subclassing preserves the original UI's nominal API type without ever calling its HTTP transport. */
class OfflineConductorApi extends ConductorApi {
  #result: OfflineNativeResult;
  #tail: Promise<unknown> = Promise.resolve();
  #listeners = new Set<Listener>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  #clock: () => number;
  #lastClock: number;
  #clockRevision = 0;
  #visible: boolean;
  #unsubscribeVisibility: () => void;
  #atlasCache = new Map<string, Uint8Array>();
  #generation = 0;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #saveRevision = 0;
  #saveTail: Promise<void> = Promise.resolve();
  readonly persistence: { available: boolean; restored: boolean; message: string | null };

  constructor(private readonly options: OfflineApiOptions, result: OfflineNativeResult,
    private readonly storage: OfflineStorage | null, private readonly storageKey: string,
    persistence: { available: boolean; restored: boolean; message: string | null }) {
    super("offline://local", result.context.worldId, result.context.operatorId, result.context.trainRunId,
      async () => { throw failure("offline_http_disabled", "Diese Demo besitzt keinen Onlinezugang."); });
    this.#result = copy(result); this.#clock = options.clock ?? (() => performance.now()); this.#lastClock = this.#clock();
    this.persistence = persistence;
    const visibility = options.visibility ?? browserVisibility();
    this.#visible = visibility.isVisible();
    this.#unsubscribeVisibility = visibility.subscribe(() => {
      if (this.#disposed) return;
      this.#visible = visibility.isVisible();
      this.#resetClock();
      if (this.#timer !== undefined) { clearTimeout(this.#timer); this.#timer = undefined; }
      if (this.#visible) this.#schedule();
      else void this.flushSave();
    });
  }
  #resetClock(clock = this.#clock()): void { this.#lastClock = clock; this.#clockRevision += 1; }
  #serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(async () => {
      if (this.#disposed) throw failure("offline_disposed", "Die lokale Sitzung ist geschlossen.");
      return action();
    });
    this.#tail = run.catch(() => {}); return run;
  }
  async #invoke(command: string, input: unknown): Promise<unknown> {
    try { return await this.options.invoke(command, input); }
    catch (error) {
      if (error instanceof ConductorApiError) throw error;
      const raw = error instanceof Error ? error.message : "";
      const code = /^[a-z][a-z0-9_]{1,100}$/u.test(raw) ? raw : "offline_native_rejected";
      throw failure(code);
    }
  }
  #save(): void {
    if (this.storage === null) return;
    this.#saveRevision += 1;
    if (this.options.exportSave !== undefined) {
      // At most one scheduled save. Continuous walking does not postpone it forever.
      if (this.#saveTimer === undefined) this.#saveTimer = setTimeout(() => {
        this.#saveTimer = undefined; void this.flushSave();
      }, 2000);
      return;
    }
    try {
      const value = JSON.stringify({ schemaVersion: SAVE_SCHEMA, context: this.#result.context, checkpoint: this.#result.checkpoint });
      if (value.length > MAX_SAVE_LENGTH) throw new Error("save too large");
      this.storage.setItem(this.storageKey, value);
      this.persistence.available = true; this.persistence.message = null;
    } catch {
      this.persistence.available = false;
      this.persistence.message = "Der Browser kann diesen Stand nicht dauerhaft speichern. Die aktuelle Sitzung läuft im Speicher weiter.";
    }
  }
  async flushSave(): Promise<void> {
    if (this.#saveTimer !== undefined) { clearTimeout(this.#saveTimer); this.#saveTimer = undefined; }
    if (this.storage === null || this.options.exportSave === undefined || this.#disposed) return;
    const generation = this.#generation, revision = this.#saveRevision;
    const exportSave = this.options.exportSave;
    const save = async () => {
      if (generation !== this.#generation || this.#disposed) return;
      try {
        const text = await exportSave();
        if (text.length > MAX_SAVE_LENGTH) throw new Error("save too large");
        // localStorage is synchronous, so only this final write runs in an idle slot.
        await new Promise<void>((resolve) => {
          if (typeof globalThis.requestIdleCallback === "function") globalThis.requestIdleCallback(() => resolve(), { timeout: 1500 });
          else setTimeout(resolve, 0);
        });
        if (generation !== this.#generation || this.#disposed) return;
        this.storage!.setItem(this.storageKey, text);
        this.persistence.available = true; this.persistence.message = null;
      } catch {
        this.persistence.available = false;
        this.persistence.message = "Der Browser kann diesen Stand nicht dauerhaft speichern. Die aktuelle Sitzung läuft im Speicher weiter.";
      }
      if (revision !== this.#saveRevision && this.#saveTimer === undefined && !this.#disposed) {
        this.#saveTimer = setTimeout(() => { this.#saveTimer = undefined; void this.flushSave(); }, 2000);
      }
    };
    this.#saveTail = this.#saveTail.then(save, save);
    await this.#saveTail;
  }
  #publish(): void {
    if (this.#result.response === null) return;
    for (const listener of [...this.#listeners]) {
      try { listener.receive(copy(this.#result.response)); } catch (error) { listener.reject(error); this.#listeners.delete(listener); }
    }
  }
  async #transition(method: "offline.command" | "offline.tick", extra: Record<string, unknown> = {}): Promise<OfflineNativeResult> {
    const clock = this.#clock(), delta = clock - this.#lastClock;
    const paused = this.#listeners.size === 0 || !this.#visible || !Number.isFinite(delta)
      || delta < 0 || delta > MAX_CONTINUOUS_CLOCK_MS;
    // Reset before invoking Rust, including when the user's command is rejected:
    // an OS suspension must never become a permanently retried oversized tick.
    // Hidden time and long discontinuities are discarded, never split into
    // invented catch-up commands or injected into the saved native checkpoint.
    if (paused) this.#resetClock(clock);
    const elapsedMs = paused ? 0 : Math.floor(delta), clockRevision = this.#clockRevision;
    const generation = this.#generation;
    const result = validateResult(await this.#invoke(method, { fixture: this.options.fixture,
      checkpoint: this.#result.checkpoint, elapsedMs, ...extra }), this.#result.context);
    validateArtBinding(result, this.options.art);
    if (this.#disposed || generation !== this.#generation) throw failure("offline_disposed");
    this.#result = result;
    // A visibility change while an asynchronous invoke is in flight owns the
    // newer baseline; do not restore its old pre-pause wall-clock reading.
    if (clockRevision === this.#clockRevision) this.#lastClock = clock;
    this.#save(); this.#publish(); return result;
  }
  #schedule(): void {
    if (this.#disposed || !this.#visible || this.#listeners.size === 0 || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#serial(async () => { if (this.#visible) await this.#transition("offline.tick"); }).catch((error) => {
        for (const listener of this.#listeners) listener.reject(error);
        this.#listeners.clear();
      }).finally(() => this.#schedule());
    }, this.options.pulseMs ?? 1000);
  }
  override async availability(): Promise<ConductorAvailability> { return this.#serial(async () => copy(this.#result.availability)); }
  override async snapshot(): Promise<ConductorResponse> {
    return this.#serial(async () => {
      if (this.#result.response === null) throw failure("conductor_session_missing", "Öffne zuerst eine lokale Schaffnersitzung.");
      return copy(this.#result.response);
    });
  }
  override async command(command: ConductorCommandV1): Promise<ConductorResponse> {
    return this.#serial(async () => {
      if (command.worldId !== this.worldId || command.trainRunId !== this.trainRunId) throw failure("conductor_access_denied");
      const result = await this.#transition("offline.command", { command });
      // Decisions/start/exit are durably written before their acknowledgement;
      // only repeated walking and clock updates use the periodic idle save.
      if (command.action.type !== "move") await this.flushSave();
      if (result.response === null) throw failure("offline_snapshot_missing");
      return copy(result.response);
    });
  }
  override async report(): Promise<ConductorControlStatus> { return this.#serial(async () => copy(this.#result.report)); }
  override async art(): Promise<ConductorArtViewV1> { return copy(this.options.art); }
  override async atlas(fileId: string): Promise<Uint8Array> {
    let bytes = this.#atlasCache.get(fileId);
    if (bytes === undefined) {
      if (!this.options.art.files.some((file) => file.id === fileId) || !Object.hasOwn(this.options.atlases, fileId)) throw failure("offline_atlas_missing");
      const raw = atob(this.options.atlases[fileId]!); bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      this.#atlasCache.set(fileId, bytes);
    }
    return bytes.slice();
  }
  override async path(nodeId: string): Promise<ConductorWalkingPath> {
    return this.#serial(async () => {
      const response = this.#result.response;
      if (response === null) throw failure("conductor_session_missing");
      const path = object(await this.#invoke("offline.path", { fixture: this.options.fixture,
        checkpoint: this.#result.checkpoint, targetNodeId: nodeId }));
      if (path.layoutHash !== response.layout.layoutHash || !Array.isArray(path.points)) throw failure("offline_path_binding_mismatch");
      return copy(path as unknown as ConductorWalkingPath);
    });
  }
  override async stream(_sequence: number, signal: AbortSignal, receive: (value: StreamValue) => void): Promise<void> {
    if (signal.aborted || this.#disposed) return;
    return new Promise<void>((resolve, reject) => {
      const listener: Listener = { receive, reject: (reason) => { cleanup(); reject(reason); } };
      const cleanup = () => {
        this.#listeners.delete(listener); signal.removeEventListener("abort", stop);
        if (this.#listeners.size === 0 && this.#timer !== undefined) { clearTimeout(this.#timer); this.#timer = undefined; }
      };
      const stop = () => { cleanup(); resolve(); };
      if (this.#listeners.size === 0) this.#resetClock();
      this.#listeners.add(listener); signal.addEventListener("abort", stop, { once: true });
      this.#schedule();
    });
  }
  async reset(): Promise<void> {
    await this.#serial(async () => {
      if (this.#listeners.size > 0) throw failure("offline_close_before_reset", "Schließe den Schaffnermodus vor einem Neustart.");
      const result = validateResult(await this.#invoke("offline.initialize", { fixture: this.options.fixture }), this.#result.context);
      validateArtBinding(result, this.options.art);
      this.#generation += 1; this.#result = result; this.#resetClock();
      this.persistence.restored = false; this.#save();
      await this.flushSave();
    });
  }
  dispose(): void {
    this.#disposed = true; this.#generation += 1;
    this.#unsubscribeVisibility();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#saveTimer !== undefined) clearTimeout(this.#saveTimer);
    for (const listener of [...this.#listeners]) listener.reject(failure("offline_disposed"));
    this.#listeners.clear(); this.#atlasCache.clear();
  }
}

export async function createOfflineConductorApi(options: OfflineApiOptions): Promise<OfflineDemoSession> {
  const initial = validateResult(await options.invoke("offline.initialize", { fixture: options.fixture }));
  const storageKey = options.storageKey ?? `zugfolge-m15-offline:${initial.context.fixtureHash}`;
  let storage = options.storage ?? null;
  if (options.storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  const persistence = { available: storage !== null, restored: false, message: storage === null
    ? "Dieser Browser stellt keinen lokalen Speicher bereit. Die Demo läuft bis zum Schließen des Fensters." : null };
  let result = initial;
  let saved: string | null = null;
  if (storage !== null) {
    try { saved = storage.getItem(storageKey); }
    catch {
      storage = null; persistence.available = false;
      persistence.message = "Dieser Browser erlaubt keinen lokalen Speicherzugriff. Die Demo läuft bis zum Schließen des Fensters.";
    }
  }
  if (saved !== null) {
    try {
      if (saved.length > MAX_SAVE_LENGTH) throw failure("offline_save_invalid");
      const value = object(JSON.parse(saved));
      if (value.schemaVersion !== SAVE_SCHEMA || !sameContext(validateContext(value.context), initial.context)) throw failure("offline_save_wrong_fixture");
      result = validateResult(await options.invoke("offline.restore", { fixture: options.fixture, checkpoint: value.checkpoint }), initial.context);
      persistence.restored = true;
    } catch {
      // Never convert a damaged native checkpoint into a successful continuation.
      throw failure("offline_restore_rejected", "Der gespeicherte lokale Stand konnte nicht bestätigt werden. Entferne ihn über „Gespeicherte Demo zurücksetzen“ und starte neu.");
    }
  }
  validateArtBinding(result, options.art);
  const api = new OfflineConductorApi(options, result, storage, storageKey, persistence);
  return { api, context: copy(result.context), persistence, reset: () => api.reset(), flushSave: () => api.flushSave(), dispose: () => api.dispose() };
}
