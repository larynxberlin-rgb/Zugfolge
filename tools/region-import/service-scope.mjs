/**
 * Deterministische Zulassung eines GTFS-Angebots zum EBO-SPNV-Alpha-Schnitt.
 *
 * Der GTFS-DE-RV-Feed ist die Quelle, aber nicht jede darin gelieferte Fahrt
 * gehoert fachlich zum ersten Geschaeftsfeld. Unbekannte Betreiber werden
 * deshalb sicher ausgeschlossen und im Releasebericht sichtbar gemacht.
 */

export const SERVICE_SCOPE_SCHEMA = "zugfolge-gtfs-service-scope/v1";

function stringSet(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value === "")) {
    throw new Error(`${label} muss eine Liste nichtleerer Zeichenketten sein.`);
  }
  return new Set(values);
}

export function compileServiceScope(specification) {
  if (specification?.schema !== SERVICE_SCOPE_SCHEMA) {
    throw new Error("Unbekanntes GTFS-Service-Scope-Schema.");
  }
  const allowedRouteTypes = stringSet(specification.allowedRouteTypes, "allowedRouteTypes");
  const includedAgencyIds = stringSet(specification.includedAgencyIds, "includedAgencyIds");
  const excludedByAgency = new Map();
  for (const exclusion of specification.excludedAgencies ?? []) {
    if (typeof exclusion?.agencyId !== "string" || exclusion.agencyId === ""
      || typeof exclusion?.category !== "string" || exclusion.category === ""
      || typeof exclusion?.reason !== "string" || exclusion.reason === "") {
      throw new Error("Jeder Betreiber-Ausschluss benoetigt agencyId, category und reason.");
    }
    if (includedAgencyIds.has(exclusion.agencyId) || excludedByAgency.has(exclusion.agencyId)) {
      throw new Error(`Betreiber ${exclusion.agencyId} ist doppelt oder widerspruechlich klassifiziert.`);
    }
    excludedByAgency.set(exclusion.agencyId, exclusion);
  }

  return Object.freeze({
    decide(route) {
      if (route === undefined) {
        return { included: false, category: "missing-route", reason: "GTFS-Fahrt verweist auf keine vorhandene Route." };
      }
      if (!allowedRouteTypes.has(route.route_type)) {
        return { included: false, category: "non-rail", reason: `route_type=${route.route_type || "missing"} ist fuer den EBO-SPNV-Schnitt nicht zugelassen.` };
      }
      const explicitExclusion = excludedByAgency.get(route.agency_id);
      if (explicitExclusion !== undefined) {
        return { included: false, category: explicitExclusion.category, reason: explicitExclusion.reason };
      }
      if (!includedAgencyIds.has(route.agency_id)) {
        return { included: false, category: "unclassified-agency", reason: `Betreiber ${route.agency_id || "missing"} ist im gepinnten SPNV-Scope nicht freigegeben.` };
      }
      return { included: true, category: "spnv", reason: "Betreiber und Verkehrsmittel sind im versionierten EBO-SPNV-Scope zugelassen." };
    },
  });
}

