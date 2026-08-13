/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";

const POLL_MS = 60_000;

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
}

function definition(term, value) {
    const wrapper = element("div");
    wrapper.append(element("dt", term), element("dd", value));
    return wrapper;
}

function runtime(seconds) {
    if (seconds === null) return _t("Unbefristet");
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    return days ? _t("%s Tage %s Stunden", days, hours) : _t("%s Stunden", hours);
}

function card(world) {
    const article = element("article", null, "zf-world-card");
    const image = element("img");
    image.src = world.banner.url1024;
    image.srcset = `${world.banner.url512} 512w, ${world.banner.url1024} 1024w, ${world.banner.url1920} 1920w`;
    image.alt = world.banner.alt;
    image.loading = "lazy";
    image.style.objectPosition = `${world.banner.focalXPermille / 10}% ${world.banner.focalYPermille / 10}%`;
    const body = element("div", null, "zf-world-card__body");
    const title = element("h3");
    const link = element("a", world.name);
    link.href = `/welten/${encodeURIComponent(world.worldId)}`;
    title.append(link);
    body.append(element("p", world.phase, "zf-world-card__phase"));
    const stats = element("dl", null, "zf-stat-grid");
    const remaining = runtime(world.remainingRuntimeSeconds);
    stats.append(
        definition(_t("Beginn"), world.startsAt),
        definition(_t("Ende"), world.endsAt || _t("Unbefristet")),
        definition(_t("Verbleibend"), remaining),
        definition(_t("Startkapital"), world.startingCapital),
        definition(_t("Preis"), world.price === null ? _t("Teilnahme auf Anfrage") : `${world.price} ${world.currency}`),
        definition("EVU", world.totalOperators),
        definition(_t("Stark aktiv"), world.stronglyActiveOperators === null ? _t("Nicht ausgewiesen") : world.stronglyActiveOperators),
        definition(_t("Freie Plätze"), `${world.freePlaces} / ${world.capacity}`),
        definition(_t("Aufnahmestatus"), world.admissionStatus),
    );
    body.append(title, element("p", world.description), stats, element("p", world.conditions));
    body.append(element("p", _t("Region: %s · Regelwerk: %s", world.region, world.ruleRelease), "zf-world-card__meta"));
    const releases = Object.entries(world.releases || {}).map(([name, value]) => `${name}: ${value}`).join(" · ");
    if (releases) body.append(element("p", releases, "zf-world-card__meta"));
    body.append(element("p", _t("Stand: %s", world.generatedAt), "zf-world-card__meta"));
    body.append(element("p", _t("Autoritative Weltzeit: %s", world.authoritativeAsOf), "zf-world-card__meta"));
    if (world.stale) body.append(element("p", _t("Daten möglicherweise veraltet · Stand %s", world.generatedAt), "alert alert-warning"));
    article.append(image, body);
    return article;
}

function render(snippet, worlds) {
    const status = snippet.querySelector(".zf-snippet__status");
    const content = snippet.querySelector(".zf-snippet__content");
    content.replaceChildren();
    if (!worlds.length) {
        status.textContent = _t("Keine passende veröffentlichte Welt vorhanden.");
        return;
    }
    status.textContent = "";
    const kind = snippet.dataset.zugfolgeWorlds;
    if (kind === "cards") {
        content.append(...worlds.map(card));
        return;
    }
    const world = worlds[0];
    if (kind === "banner") {
        content.append(card(world));
    } else if (kind === "stats") {
        const stats = element("dl", null, "zf-stat-grid");
        stats.append(
            definition(_t("Phase"), world.phase), definition(_t("Startkapital"), world.startingCapital),
            definition(_t("Verbleibend"), runtime(world.remainingRuntimeSeconds)),
            definition(_t("Freie Plätze"), `${world.freePlaces} / ${world.capacity}`),
        );
        content.append(stats);
    } else if (kind === "evu") {
        const stats = element("dl", null, "zf-stat-grid");
        stats.append(definition(_t("EVU gesamt"), world.totalOperators), definition(_t("Stark aktiv"), world.stronglyActiveOperators === null ? _t("Nicht ausgewiesen") : world.stronglyActiveOperators));
        content.append(stats, element("p", world.activityExplanation));
    }
}

async function refresh(snippet) {
    if (document.body.classList.contains("editor_enable")) return;
    const params = new URLSearchParams({ selector: snippet.dataset.worldSelector || "all" });
    if (snippet.dataset.worldId) params.set("world_id", snippet.dataset.worldId);
    const status = snippet.querySelector(".zf-snippet__status");
    status.textContent = _t("Weltdaten werden geladen …");
    try {
        const response = await fetch(`/zugfolge/public/worlds?${params}`, { headers: { Accept: "application/json" }, credentials: "same-origin" });
        if (response.status === 429) throw new Error("rate_limited");
        if (!response.ok) throw new Error("request_failed");
        const payload = await response.json();
        render(snippet, Array.isArray(payload.worlds) ? payload.worlds : []);
    } catch (_error) {
        status.textContent = _t("Weltdaten sind vorübergehend nicht verfügbar. Bitte später erneut versuchen.");
        status.classList.add("alert", "alert-warning");
    }
}

function start(snippet) {
    refresh(snippet);
    const timer = window.setInterval(() => { if (!document.hidden) refresh(snippet); }, POLL_MS);
    window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
}

document.querySelectorAll("[data-zugfolge-worlds]").forEach(start);
