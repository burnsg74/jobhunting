// Thin fetch wrapper. The frontend only talks to /api/*, never to disk.

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // non-JSON error body
  }
  if (!res.ok) throw new Error(payload?.error ?? `Request failed (${res.status})`);
  return payload;
}

const enc = encodeURIComponent;

function qs(params) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") q.set(key, String(value));
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}

export const api = {
  jobs: (params = {}) => request("GET", `/api/jobs${qs(params)}`),
  job: (id) => request("GET", `/api/jobs/${enc(id)}`),
  setStatus: (id, status, body) => request("POST", `/api/jobs/${enc(id)}/status`, { status, ...(body ? { body } : {}) }),
  events: (params = {}) => request("GET", `/api/events${qs(params)}`),
  createEvent: (input) => request("POST", "/api/events", input),
  updateEvent: (id, patch) => request("PATCH", `/api/events/${enc(id)}`, patch),
  deleteEvent: (id) => request("DELETE", `/api/events/${enc(id)}`),
  daily: (params = {}) => request("GET", `/api/reports/daily${qs(params)}`),
  currentPull: () => request("GET", "/api/pulls/current"),
  startPull: () => request("POST", "/api/pulls"),
  cancelPull: () => request("POST", "/api/pulls/current/cancel"),
};
