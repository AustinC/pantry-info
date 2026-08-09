/**
 * Popup controller.
 *
 * On open it injects extract.js into the active tab (permitted by activeTab, so the
 * extension needs no standing access to any recipe site), previews what it found, and
 * offers three ways out: POST to the local receiver, save a .json file, or copy JSON.
 */

const api = typeof browser !== "undefined" ? browser : chrome;

const els = {
  conn: document.getElementById("conn"),
  status: document.getElementById("status"),
  preview: document.getElementById("preview"),
  title: document.getElementById("title"),
  meta: document.getElementById("meta"),
  actions: document.getElementById("actions"),
  send: document.getElementById("send"),
  save: document.getElementById("save"),
  copy: document.getElementById("copy"),
  port: document.getElementById("port"),
};

let captured = null;

function setStatus(text, kind = "") {
  els.status.hidden = false;
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

function receiverBase() {
  const port = parseInt(els.port.value, 10) || 8787;
  return `http://127.0.0.1:${port}`;
}

/** Slug for the saved filename, derived from the recipe title. */
function filenameFor(title) {
  const slug = (title || "recipe")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "recipe";
  return `pantry-info/${slug}.json`;
}

async function checkReceiver() {
  els.conn.className = "conn checking";
  els.conn.textContent = "checking…";
  try {
    const res = await fetch(`${receiverBase()}/ping`, { method: "GET" });
    const body = await res.json();
    if (body.ok) {
      els.conn.className = "conn up";
      els.conn.textContent = `connected · ${body.recipes}`;
      els.conn.title = `pantry-info receiver, ${body.recipes} recipes stored`;
      return true;
    }
  } catch {
    // Receiver isn't running — saving and copying still work.
  }
  els.conn.className = "conn down";
  els.conn.textContent = "offline";
  els.conn.title = "Run `pantry-info receive` to enable one-click sending";
  return false;
}

async function capture() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) {
    setStatus("Open a recipe page first.", "error");
    return;
  }

  let results;
  try {
    // Passing the function itself serialises its source into the page, so there
    // is no dependency on two injections sharing an isolated-world global.
    results = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractRecipeFromPage,
    });
  } catch (e) {
    setStatus(`Could not read the page: ${e.message}`, "error");
    return;
  }

  const result = results && results[0] && results[0].result;
  if (!result) {
    setStatus("Could not read the page.", "error");
    return;
  }
  if (!result.ok) {
    setStatus(result.error, "error");
    return;
  }

  captured = result.envelope;
  const p = result.preview;
  els.title.textContent = p.title;
  els.meta.textContent = [
    p.author,
    `${p.ingredients} ingredients`,
    `${p.steps} steps`,
    p.host,
  ].filter(Boolean).join(" · ");
  els.preview.hidden = false;
  els.actions.hidden = false;
  els.status.hidden = true;
}

els.send.addEventListener("click", async () => {
  if (!captured) return;
  els.send.disabled = true;
  setStatus("Sending…", "working");
  try {
    const res = await fetch(`${receiverBase()}/recipe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(captured),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) {
      setStatus(
        `${body.updated ? "Updated" : "Saved"}: ${body.title} (${body.ingredients} ingredients)`,
        "success",
      );
      checkReceiver();
    } else {
      setStatus(body.error || `Receiver returned ${res.status}`, "error");
    }
  } catch {
    setStatus("No receiver on that port. Run `pantry-info receive`.", "error");
  } finally {
    els.send.disabled = false;
  }
});

els.save.addEventListener("click", async () => {
  if (!captured) return;
  const blob = new Blob([JSON.stringify(captured, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    await api.downloads.download({
      url,
      filename: filenameFor(captured.jsonld && captured.jsonld.name),
      saveAs: false,
    });
    setStatus("Saved to your downloads folder.", "success");
  } catch (e) {
    setStatus(`Could not save: ${e.message}`, "error");
  } finally {
    // Revoke late; Firefox needs the URL alive until the download starts.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
});

els.copy.addEventListener("click", async () => {
  if (!captured) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(captured));
    setStatus("JSON copied. Pipe it to `pantry-info import-json -`.", "success");
  } catch (e) {
    setStatus(`Could not copy: ${e.message}`, "error");
  }
});

els.port.addEventListener("change", () => {
  api.storage.local.set({ port: els.port.value });
  checkReceiver();
});

(async function init() {
  const { port } = await api.storage.local.get("port");
  if (port) els.port.value = port;
  checkReceiver();
  capture();
})();
