import type { ConductorArtViewV1 } from "@zugfolge-offline/conductor-renderer";
import view from "../data/art-view.json";
import files from "../data/atlases.json";

// Die vollständige Format-/Dateihashprüfung erfolgt vor jedem HTML-Build.
export const art = view as ConductorArtViewV1;
export const atlases: Readonly<Record<string, string>> = Object.freeze(files);
