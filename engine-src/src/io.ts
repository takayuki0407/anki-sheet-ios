// Shared loaders for the engine (detection bridge + viewer).
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// XHR (not fetch) is the most compatible way to read a local file:// URL inside WKWebView.
export function loadArrayBuffer(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
      if (ok && xhr.response) resolve(xhr.response as ArrayBuffer);
      else reject(new Error(`load ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("load failed"));
    xhr.send();
  });
}

// Read a local file:// (or http) resource as text — used to load the viewer's answer
// rects from a staged JSON file instead of pushing a large payload through the bridge.
export function loadText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "text";
    xhr.onload = () => {
      const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
      if (ok) resolve(xhr.responseText);
      else reject(new Error(`load ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("load failed"));
    xhr.send();
  });
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function pdfBytes(m: { url?: string; base64?: string }): Promise<ArrayBuffer> {
  if (m.url) return loadArrayBuffer(m.url);
  if (m.base64) return base64ToArrayBuffer(m.base64);
  throw new Error("no pdf source");
}
