import type { OfflineInvoke } from "./offline-api.js";
import { installOfflineWorker } from "./worker-runtime.ts";

interface JsonKernelExports {
  readonly memory: WebAssembly.Memory;
  readonly alloc: (length: number) => number;
  readonly dealloc: (pointer: number, length: number) => void;
  readonly invoke: (pointer: number, length: number) => number;
  readonly result_len: () => number;
}

/** Embedded bytes only: no URL, HTTP, WASI, filesystem or network imports. */
export async function loadOfflineKernel(bytes: Uint8Array): Promise<{ invoke: OfflineInvoke; kernelSha256: string }> {
  // Local constants keep this function self-contained when embedded in a worker.
  const MAX_INPUT_BYTES = 32 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
  const module = await WebAssembly.compile(bytes as BufferSource);
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error("offline_kernel_external_imports");
  const instance = await WebAssembly.instantiate(module, {}), exports = instance.exports;
  if (!(exports.memory instanceof WebAssembly.Memory) || ["alloc", "dealloc", "invoke", "result_len"]
    .some((name) => typeof exports[name] !== "function")) throw new Error("offline_kernel_exports_invalid");
  const kernel = exports as unknown as JsonKernelExports;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const kernelSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
  let calling = false;
  const invoke: OfflineInvoke = (command, input) => {
    if (calling) throw new Error("offline_kernel_reentrant_call");
    const request = encoder.encode(JSON.stringify({ command, input }));
    if (request.byteLength > MAX_INPUT_BYTES) throw new Error("offline_input_too_large");
    calling = true;
    let pointer: number | undefined;
    try {
      pointer = kernel.alloc(request.byteLength) >>> 0;
      if (pointer === 0 || pointer + request.byteLength > kernel.memory.buffer.byteLength) throw new Error("offline_allocation_failed");
      new Uint8Array(kernel.memory.buffer, pointer, request.byteLength).set(request);
      const resultPointer = kernel.invoke(pointer, request.byteLength) >>> 0;
      const resultLength = kernel.result_len() >>> 0;
      if (resultPointer === 0 || resultLength === 0 || resultLength > MAX_OUTPUT_BYTES
        || resultPointer + resultLength > kernel.memory.buffer.byteLength) throw new Error("offline_result_invalid");
      const reply: unknown = JSON.parse(decoder.decode(new Uint8Array(kernel.memory.buffer, resultPointer, resultLength)));
      if (reply === null || typeof reply !== "object" || Array.isArray(reply)) throw new Error("offline_result_invalid");
      const result = reply as { ok?: unknown; value?: unknown; error?: unknown };
      if (result.ok !== true) {
        throw new Error(typeof result.error === "string" && /^[a-z][a-z0-9_]{1,100}$/u.test(result.error)
          ? result.error : "offline_native_rejected");
      }
      if (!Object.hasOwn(result, "value")) throw new Error("offline_result_invalid");
      return result.value;
    } finally {
      if (pointer !== undefined && pointer !== 0) kernel.dealloc(pointer, request.byteLength);
      calling = false;
    }
  };
  return { invoke, kernelSha256 };
}

/** Der Worker liefert öffentliche Ansichten; nur der lokale Speicherexport enthält den privaten Übungsstand. */
export async function loadOfflineKernelWorker(bytes: Uint8Array, fixture: unknown, scene: unknown) {
  const url = URL.createObjectURL(new Blob([`(${installOfflineWorker.toString()})(${loadOfflineKernel.toString()});`], { type: 'text/javascript' }));
  const worker = new Worker(url, { name: 'zugfolge-original-rust' });
  URL.revokeObjectURL(url);
  let serial = 0, disposed = false;
  let terminalError: Error | null = null;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const layouts = new Map<string, unknown>();
  const samples: { command: string; nativeMs: number; workerMs: number; roundtripMs: number }[] = [];
  const request = (payload: unknown, transfer: Transferable[] = []): Promise<any> => {
    if (disposed) return Promise.reject(new Error('offline_worker_disposed'));
    if (terminalError) return Promise.reject(terminalError);
    const id = ++serial;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ ...(payload as object), id }, transfer); });
  };
  const fail = () => {
    if (terminalError) return;
    terminalError = new Error('offline_worker_failed');
    worker.terminate();
    for (const operation of pending.values()) operation.reject(terminalError);
    pending.clear(); layouts.clear();
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  worker.onmessage = (event) => {
    const message = event.data, operation = pending.get(message?.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.ok === true) operation.resolve(message.value);
    else operation.reject(new Error(typeof message.error === 'string' ? message.error : 'offline_worker_failed'));
  };
  const owned = bytes.slice();
  let ready: { kernelSha256: string };
  try { ready = await request({ kind: 'boot', bytes: owned.buffer, fixture, scene }, [owned.buffer]); }
  catch (error) { worker.terminate(); throw error; }
  const invoke: OfflineInvoke = async (command, input) => {
    const started = performance.now();
    // Fixture is fixed at boot. Only a small checkpoint reference travels back.
    const { fixture: _fixture, ...parameters } = input as Record<string, unknown>;
    const value = await request({ kind: 'invoke', command, input: parameters });
    if (value.metrics) { samples.push({ ...value.metrics, roundtripMs: performance.now() - started }); if (samples.length > 256) samples.shift(); }
    const result = value.result;
    if (result?.response?.layout?.offlineLayoutReference) {
      const layout = layouts.get(result.response.layout.offlineLayoutReference);
      if (!layout) throw new Error('offline_worker_layout_missing');
      result.response.layout = layout;
    } else if (result?.response?.layout?.layoutHash) layouts.set(result.response.layout.layoutHash, result.response.layout);
    return result;
  };
  return { invoke, kernelSha256: ready.kernelSha256,
    exportSave: async (): Promise<string> => (await request({ kind: 'save' })).text,
    performance: () => samples.map((sample) => ({ ...sample })),
    dispose: () => { disposed = true; fail(); },
  };
}
