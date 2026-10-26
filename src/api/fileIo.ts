// duidelik — browser file download / upload helpers (per-artifact SharePoint round-trip)
//
// The ONLY place that touches the DOM download/upload machinery, so the pages stay
// declarative and this stays easy to swap for a Graph-API "Save to SharePoint" call
// later (see core/artifact.ts header). No secrets, no network — a pure local file
// round-trip: the human saves the downloaded file to their SharePoint library and
// picks a file synced back from it.

/** Trigger a browser download of `text` as `filename` (application/json). */
export function downloadTextFile(filename: string, text: string, mime = "application/json"): void {
  if (typeof document === "undefined") return; // SSR / test guard
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick so the click has resolved.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Open the OS file picker and resolve with the chosen file's text, or null if the user
 * cancelled. Restricted to .json by default. Rejects on read error.
 */
export function pickTextFile(accept = "application/json,.json"): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    // `cancel` fires on modern browsers when the dialog is dismissed with no file.
    input.addEventListener("cancel", () => {
      cleanup();
      resolve(null);
    });
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) {
        cleanup();
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        cleanup();
        resolve(typeof reader.result === "string" ? reader.result : null);
      };
      reader.onerror = () => {
        cleanup();
        reject(reader.error || new Error("Could not read the file."));
      };
      reader.readAsText(file);
    });
    function cleanup() {
      if (input.parentNode) input.parentNode.removeChild(input);
    }
    document.body.appendChild(input);
    input.click();
  });
}
