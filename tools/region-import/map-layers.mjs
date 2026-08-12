export function classifyMapFeature(feature) {
  if (feature?.type !== "Feature" || typeof feature.properties !== "object" || feature.properties === null) return null;
  const properties = feature.properties;
  const railway = properties.railway;
  if (typeof railway !== "string") return null;
  const gauge = typeof properties.gauge === "string" ? Number.parseInt(properties.gauge.split(";")[0].trim(), 10) : 1_435;
  const line = feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString";
  const included = line && railway === "rail" && gauge === 1_435 && properties.electrified !== "rail";
  let qualityClass = "C";
  if (included && typeof properties.maxspeed === "string" && typeof properties.electrified === "string"
    && (typeof properties.usage === "string" || typeof properties.service === "string")) qualityClass = "B";
  if (qualityClass === "B" && properties["zugfolge:validated"] === "yes") qualityClass = "A";
  const reason = included ? null
    : !line ? "non-line-railway-context"
      : railway !== "rail" ? `railway-${railway}`
        : gauge !== 1_435 ? `gauge-${properties.gauge}` : "third-rail";
  return {
    layer: included ? "rail" : "context",
    feature: {
      type: "Feature",
      ...(feature.id === undefined ? {} : { id: feature.id }),
      geometry: feature.geometry,
      properties: {
        railway,
        ...(typeof properties.name === "string" ? { name: properties.name } : {}),
        ...(typeof properties.ref === "string" ? { ref: properties.ref } : {}),
        ...(typeof properties.service === "string" ? { service: properties.service } : {}),
        ...(typeof properties.gauge === "string" ? { gauge: properties.gauge } : {}),
        ...(typeof properties.electrified === "string" ? { electrified: properties.electrified } : {}),
        qualityClass,
        orderable: included && qualityClass !== "C",
        ...(reason === null ? {} : { exclusionReason: reason }),
      },
    },
  };
}

