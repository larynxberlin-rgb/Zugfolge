/**
 * Ein sehr kleiner Glob-Abgleich.
 *
 * Bewusst ohne Abhängigkeit: Die Wächter sind das Werkzeug, das die
 * Lizenzlage der Abhängigkeiten prüft. Je weniger sie selbst mitbringen, desto
 * weniger prüft dieses Werkzeug sich selbst im Kreis.
 *
 * Unterstützt `*` (kein `/`), `**` (beliebig tief, `/` eingeschlossen) und `?`.
 */

const SONDERZEICHEN = /[.+^${}()|[\]\\]/g;

/** Übersetzt ein Glob-Muster in einen verankerten regulären Ausdruck. */
export function globToRegExp(pattern: string): RegExp {
  let quelle = "";
  let index = 0;

  while (index < pattern.length) {
    const zeichen = pattern[index];
    if (zeichen === undefined) {
      break;
    }

    if (zeichen === "*") {
      const doppelt = pattern[index + 1] === "*";
      if (doppelt) {
        // `a/**/b` soll auch `a/b` treffen, `a/**` alles darunter.
        if (pattern[index + 2] === "/") {
          quelle += "(?:.*/)?";
          index += 3;
        } else {
          quelle += ".*";
          index += 2;
        }
      } else {
        quelle += "[^/]*";
        index += 1;
      }
      continue;
    }

    if (zeichen === "?") {
      quelle += "[^/]";
      index += 1;
      continue;
    }

    quelle += zeichen.replace(SONDERZEICHEN, "\\$&");
    index += 1;
  }

  return new RegExp(`^${quelle}$`);
}

/** Kompiliert eine Musterauswahl einmal für beliebig viele Pfadprüfungen. */
export function compileGlobs(patterns: readonly string[]): (path: string) => boolean {
  const muster = patterns.map(globToRegExp);
  return (path) => muster.some((pattern) => pattern.test(path));
}
