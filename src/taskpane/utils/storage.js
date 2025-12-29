const STORAGE_KEY = "redline-ai.settings";

function hasOfficeStorage() {
  return typeof OfficeRuntime !== "undefined" && OfficeRuntime.storage;
}

export async function loadSettings() {
  if (hasOfficeStorage()) {
    const raw = await OfficeRuntime.storage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

export async function saveSettings(settings) {
  const raw = JSON.stringify(settings);

  if (hasOfficeStorage()) {
    await OfficeRuntime.storage.setItem(STORAGE_KEY, raw);
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
  } catch (error) {
    // Ignore storage failures (private mode, policy restrictions).
  }
}
