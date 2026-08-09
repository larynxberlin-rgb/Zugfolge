import {
  interpolatedPosition,
  LivemapConnection,
  type LiveState,
  type PublicTrain,
} from "./protocol.js";
import "./style.css";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SAFE_STATUSES = new Set(["planned", "running", "waiting", "at_platform", "completed", "cancelled"]);

let trains: PublicTrain[] = [];
let selectedTrainId: string | undefined;
let receivedAt = performance.now();
let renderGeneration = 0;

const details = document.querySelector<HTMLElement>("#details")!;
const trainLayer = document.querySelector<SVGGElement>("#trains")!;
const sequence = document.querySelector<HTMLTimeElement>("header time")!;

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

function select(id: string): void {
  const train = trains.find((item) => item.id === id);
  if (train === undefined) return;
  selectedTrainId = id;
  document.querySelectorAll<SVGGElement>(".train").forEach((node) => {
    node.classList.toggle("selected", node.dataset["id"] === id);
  });

  const list = document.createElement("dl");
  addDefinition(list, "Status", train.status === "waiting" ? "wartet" : "unterwegs");
  addDefinition(
    list,
    "Verspätung",
    `+${Math.floor(train.delaySeconds / 60)} min`,
    train.delaySeconds > 180 ? "warn" : undefined,
  );
  addDefinition(
    list,
    "Geschwindigkeit",
    `${Math.floor((train.speedMmPerSecond / 1_000) * 3.6)} km/h`,
  );
  addDefinition(list, "Nächster Betriebspunkt", train.nextOperatingPoint);

  const route = document.createElement("div");
  route.className = "route";
  route.append(
    textElement("b", "Leipzig Hbf"),
    textElement("span", "ab 14:04", "done"),
    textElement("b", train.nextOperatingPoint),
    textElement("span", "an 14:38"),
    textElement("b", "Erfurt Hbf"),
    textElement("span", "an 15:27"),
  );

  details.replaceChildren(
    textElement("p", "ZUGLAUF", "eyebrow"),
    textElement("h1", train.trainNumber),
    textElement("p", `${train.operator} · ${train.category}`),
    list,
    route,
  );
}

function draw(state: LiveState): void {
  const renderAt = state.at + Math.min((performance.now() - receivedAt) / 1_000, 10);
  const nodes = trains.map((item, index) => {
    const position = interpolatedPosition(item, state.at, renderAt);
    const group = document.createElementNS(SVG_NAMESPACE, "g");
    group.dataset["id"] = item.id;
    group.setAttribute(
      "transform",
      `translate(${100 + (position % 800_000_000) / 1_000_000} ${160 + (index % 4) * 75})`,
    );
    group.classList.add("train");
    if (SAFE_STATUSES.has(item.status)) group.classList.add(item.status);
    if (selectedTrainId === item.id) group.classList.add("selected");

    const circle = document.createElementNS(SVG_NAMESPACE, "circle");
    circle.setAttribute("r", "11");
    const label = document.createElementNS(SVG_NAMESPACE, "text");
    label.setAttribute("x", "18");
    label.setAttribute("y", "5");
    label.textContent = item.trainNumber;
    group.append(circle, label);
    group.addEventListener("click", () => select(item.id));
    return group;
  });
  trainLayer.replaceChildren(...nodes);
}

function render(state: LiveState): void {
  trains = [...state.trains.values()];
  receivedAt = performance.now();
  renderGeneration += 1;
  const generation = renderGeneration;
  sequence.textContent = `Sequenz ${state.sequence}`;
  draw(state);
  let previous = performance.now();
  const animate = (now: number) => {
    if (generation !== renderGeneration) return;
    if (now - previous >= 250) {
      draw(state);
      previous = now;
    }
    if (performance.now() - receivedAt < 10_000) requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
}

const parameters = new URLSearchParams(location.search);
const worldId = parameters.get("world") ?? "00000000-0000-0000-0000-000000000001";
const connection = new LivemapConnection(parameters.get("api") ?? "", worldId, render);
void connection.connect().catch((error: unknown) => {
  sequence.textContent = "Verbindung unterbrochen";
  console.error(error);
});
window.addEventListener("beforeunload", () => connection.close());
