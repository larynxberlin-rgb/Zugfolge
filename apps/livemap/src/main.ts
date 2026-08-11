import {
  appendRenderSample,
  LivemapConnection,
  operatorLabel,
  renderTrains,
  type LiveState,
  type OperatingStatus,
  type RenderSamples,
} from "./protocol.js";
import "./style.css";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_INTERPOLATION_DURATION_MS = 2_000;
const STATUS_LABELS: Readonly<Record<OperatingStatus, string>> = {
  planned: "geplant",
  running: "unterwegs",
  waiting: "wartet",
  at_platform: "am Bahnsteig",
  completed: "beendet",
  cancelled: "fällt aus",
};

let authoritativeState: LiveState | undefined;
let renderSamples: RenderSamples | undefined;
let selectedTrainId: string | undefined;
let sampleReceivedAt = performance.now();
let renderGeneration = 0;

const details = document.querySelector<HTMLElement>("#details")!;
const trainLayer = document.querySelector<SVGGElement>("#trains")!;
const sequence = document.querySelector<HTMLTimeElement>("header time")!;
const worldLabel = document.querySelector<HTMLElement>("#world-label")!;

function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function addDefinition(list: HTMLDListElement, term: string, value: string, className?: string): void {
  list.append(textElement("dt", term), textElement("dd", value, className));
}

function delayLabel(delaySeconds: number): string {
  if (delaySeconds === 0) return "0 min";
  const sign = delaySeconds > 0 ? "+" : "−";
  return `${sign}${Math.floor(Math.abs(delaySeconds) / 60)} min`;
}

function showEmptyDetails(message = "Eine Zugfahrt auswählen."): void {
  details.replaceChildren(textElement("p", "ZUGLAUF", "eyebrow"), textElement("p", message));
}

function select(id: string): void {
  const train = authoritativeState?.trains.get(id);
  if (train === undefined) {
    selectedTrainId = undefined;
    showEmptyDetails();
    return;
  }
  selectedTrainId = id;
  document.querySelectorAll<SVGGElement>(".train").forEach((node) => {
    node.classList.toggle("selected", node.dataset["id"] === id);
  });

  const list = document.createElement("dl");
  const displayedOperator = operatorLabel(train);
  addDefinition(
    list,
    "Betreiber",
    displayedOperator,
    train.operationMarker === undefined ? undefined : "public-operation-value",
  );
  addDefinition(list, "Status", STATUS_LABELS[train.status]);
  addDefinition(
    list,
    "Verspätung",
    delayLabel(train.delaySeconds),
    train.delaySeconds > 180 ? "warn" : undefined,
  );
  addDefinition(
    list,
    "Geschwindigkeit",
    `${Math.round((train.speedMmPerSecond * 36) / 10_000)} km/h`,
  );
  addDefinition(list, "Nächster Betriebspunkt", train.nextOperatingPoint);

  details.replaceChildren(
    textElement("p", "ZUGLAUF", "eyebrow"),
    textElement("h1", train.trainNumber),
    textElement(
      "p",
      `${displayedOperator} · ${train.category}`,
      train.operationMarker === undefined ? undefined : "public-operation-label",
    ),
    list,
  );
}

function renderAt(now: number, samples: RenderSamples): number {
  const interval = samples.current.at - samples.previous.at;
  if (interval <= 0) return samples.current.at;
  const playbackDuration = Math.min(interval * 1_000, MAX_INTERPOLATION_DURATION_MS);
  const progress = Math.max(0, Math.min(1, (now - sampleReceivedAt) / playbackDuration));
  return samples.previous.at + interval * progress;
}

function draw(now: number): void {
  if (renderSamples === undefined) return;
  const trains = [...renderTrains(renderSamples, renderAt(now, renderSamples))].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const nodes = trains.map((item, index) => {
    const group = document.createElementNS(SVG_NAMESPACE, "g");
    group.dataset["id"] = item.id;
    group.setAttribute(
      "transform",
      `translate(${100 + (item.positionMm % 800_000_000) / 1_000_000} ${160 + (index % 4) * 75})`,
    );
    group.classList.add("train", item.status);
    const publicOperation = item.operationMarker !== undefined;
    if (publicOperation) group.classList.add("public-operation");
    if (selectedTrainId === item.id) group.classList.add("selected");
    group.setAttribute(
      "aria-label",
      `${item.trainNumber}, ${operatorLabel(item)}, ${STATUS_LABELS[item.status]}`,
    );

    const circle = document.createElementNS(SVG_NAMESPACE, "circle");
    circle.setAttribute("r", "11");
    const label = document.createElementNS(SVG_NAMESPACE, "text");
    label.setAttribute("x", "18");
    label.setAttribute("y", "5");
    label.textContent = item.trainNumber;
    if (publicOperation) {
      const title = document.createElementNS(SVG_NAMESPACE, "title");
      title.textContent = `${item.trainNumber}: Eigenbetrieb des Aufgabenträgers`;
      const ring = document.createElementNS(SVG_NAMESPACE, "circle");
      ring.classList.add("public-operation-ring");
      ring.setAttribute("r", "16");
      ring.setAttribute("aria-hidden", "true");
      const marker = document.createElementNS(SVG_NAMESPACE, "text");
      marker.classList.add("public-operation-glyph");
      marker.setAttribute("x", "-3");
      marker.setAttribute("y", "-17");
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = "E";
      group.append(title, ring, circle, marker, label);
    } else {
      group.append(circle, label);
    }
    group.addEventListener("click", () => select(item.id));
    return group;
  });
  trainLayer.replaceChildren(...nodes);
}

function render(state: LiveState): void {
  authoritativeState = state;
  renderSamples = appendRenderSample(renderSamples, state);
  sampleReceivedAt = performance.now();
  renderGeneration += 1;
  const generation = renderGeneration;
  worldLabel.textContent = `Livemap · Welt ${state.worldId}`;
  sequence.textContent = `Sequenz ${state.sequence}`;
  sequence.classList.remove("connection-error");
  draw(sampleReceivedAt);
  if (selectedTrainId !== undefined) select(selectedTrainId);

  const animate = (now: number) => {
    if (generation !== renderGeneration || renderSamples === undefined) return;
    draw(now);
    if (renderAt(now, renderSamples) < renderSamples.current.at) requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
}

function showConfigurationError(message: string): void {
  worldLabel.textContent = "Livemap · nicht verbunden";
  sequence.textContent = message;
  sequence.classList.add("connection-error");
  showEmptyDetails(message);
}

const parameters = new URLSearchParams(location.search);
const worldId = parameters.get("world")?.trim() ?? "";
const accessToken = sessionStorage.getItem("zugfolge.accessToken") ?? "";
let connection: LivemapConnection | undefined;

if (worldId === "") {
  showConfigurationError("Weltkennung fehlt");
} else if (accessToken === "") {
  showConfigurationError("Anmeldung fehlt");
} else {
  connection = new LivemapConnection(parameters.get("api") ?? "", worldId, accessToken, render, {
    onError: () => {
      sequence.textContent = "Verbindung unterbrochen · neuer Versuch";
      sequence.classList.add("connection-error");
    },
  });
  void connection.connect().then(
    () => sequence.classList.remove("connection-error"),
    () => {
      sequence.textContent = "Verbindung unterbrochen · neuer Versuch";
      sequence.classList.add("connection-error");
    },
  );
}

window.addEventListener("beforeunload", () => connection?.close());
