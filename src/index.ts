interface Env {
  ACCESS_KEY: string;
  CODE_TTL_SECONDS?: string;
  DOMAINS?: string;
  ANYMAIL_CODES: KVNamespace;
}

const DEFAULT_TTL_SECONDS = 600;
const CODE_REGEX = /\b(\d{5,6})\b/;

function extractEmailAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function getRecipients(message: { to?: string | string[] }): string[] {
  const list = Array.isArray(message.to) ? message.to : [message.to];
  const recipients: string[] = [];
  for (const entry of list) {
    const email = extractEmailAddress(entry ?? "");
    if (email) {
      if (!recipients.includes(email)) {
        recipients.push(email);
      }
    }
  }
  return recipients;
}

function extractCode(text: string): string | null {
  const match = CODE_REGEX.exec(text);
  return match ? match[1] : null;
}

async function readRawText(message: { raw?: ReadableStream }): Promise<string> {
  if (!message?.raw) {
    return "";
  }
  try {
    return await new Response(message.raw).text();
  } catch {
    return "";
  }
}

function getAccessKey(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function normalizeTtlSeconds(value?: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_TTL_SECONDS;
}

function buildKey(email: string): string {
  return `code:${email}`;
}

function parseDomains(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

export default {
  async email(message: { to?: string | string[]; headers?: Headers; raw?: ReadableStream }, env: Env, ctx: ExecutionContext) {
    const recipients = getRecipients(message);
    if (recipients.length === 0) {
      return;
    }

    const subject = message.headers?.get("subject") ?? "";
    const rawText = await readRawText(message);
    const code = extractCode(`${subject}\n${rawText}`);
    if (!code) {
      return;
    }

    const ttlSeconds = normalizeTtlSeconds(env.CODE_TTL_SECONDS);
    const tasks = recipients.map((recipient) =>
      env.ANYMAIL_CODES.put(buildKey(recipient), code, { expirationTtl: ttlSeconds })
    );
    ctx.waitUntil(Promise.all(tasks));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    const url = new URL(request.url);
    const accessKey = getAccessKey(request);
    if (!env.ACCESS_KEY || accessKey !== env.ACCESS_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    const path = url.pathname.replace(/^\/+/, "");
    switch (path) {
      case "":
        return json({ domains: parseDomains(env.DOMAINS) });
      default: {
        const email = extractEmailAddress(decodeURIComponent(path));
        if (!email) {
          return json({ error: "invalid email" }, 400);
        }

        const code = await env.ANYMAIL_CODES.get(buildKey(email));
        if (!code) {
          return json({ code: "" }, 404);
        }

        return json({ code });
      }
    }
  }
};
