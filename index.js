// index.js (ESM)
// Requisitos: "type": "module" no package.json
// Ambiente Render: precisa escutar em process.env.PORT e 0.0.0.0

import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) throw new Error("Missing INTERNAL_API_TOKEN env var");

const SUPABASE_PROJECT_URL =
  process.env.SUPABASE_PROJECT_URL || "https://mqnvfjteuwqbomvbmyhd.supabase.co";

const PORT = Number(process.env.PORT || 10000);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));

// -------------------------
// Logging helpers
function now() {
  return new Date().toISOString();
}
function rid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function log(id, ...args) {
  console.log(`[${now()}] [${id}]`, ...args);
}
function warn(id, ...args) {
  console.warn(`[${now()}] [${id}]`, ...args);
}
function errlog(id, ...args) {
  console.error(`[${now()}] [${id}]`, ...args);
}

// -------------------------
// CORS (defensivo; segurança real é o token)
app.use(
  cors({
    origin: (origin, cb) => {
      // server-to-server geralmente vem sem Origin
      if (!origin) return cb(null, true);

      // se veio do seu projeto supabase (caso você chame via browser por algum motivo)
      if (SUPABASE_PROJECT_URL && origin === SUPABASE_PROJECT_URL) return cb(null, true);

      // bloqueia browsers aleatórios
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "OPTIONS", "GET"],
    allowedHeaders: ["Content-Type", "X-Internal-Token"],
    maxAge: 86400,
  })
);

// Preflight sempre responde
app.options("*", (req, res) => res.sendStatus(204));

// -------------------------
// Health endpoints (sem token)
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// -------------------------
// Token gate (somente rotas “de verdade”)
app.use((req, res, next) => {
  if (req.method === "GET") return next(); // libera / e /health

  const token = req.header("X-Internal-Token");
  if (token !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

// -------------------------
// Random human-like delay (1.0s a 1.5s)
function randomDelayMs(min = 1000, max = 1500) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
async function humanPause(page, requestId, label = "pause") {
  const ms = randomDelayMs(1000, 1500);
  log(requestId, `[HUMAN] ${label}: sleeping ${ms}ms`);
  await page.waitForTimeout(ms);
}

// -------------------------
// Puppeteer helpers
async function gotoWithRetry(page, url, requestId, opts, retries = 4) {
  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log(requestId, `[INPI] goto attempt ${attempt}/${retries}: ${url}`);
      const resp = await page.goto(url, opts);
      const status = resp?.status?.() ?? "no-response";
      log(requestId, `[INPI] goto OK status=${status} finalUrl=${page.url()}`);
      return resp;
    } catch (e) {
      lastErr = e;
      warn(requestId, `[INPI] goto FAIL attempt ${attempt}: ${url}`, e?.message || e);

      // backoff + jitter
      const backoff = 800 * attempt + randomDelayMs(0, 400);
      log(requestId, `[INPI] backoff ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw lastErr;
}

async function fetchInpiHtmlByMarca(marca, requestId) {
  log(requestId, "[INPI] Launching browser...");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      // evita alguns crashes em ambientes container
      "--single-process",
    ],
  });

  try {
    const page = await browser.newPage();

    // estabilidade
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"
    );

    // ---- Logs úteis pro Render
    page.on("requestfailed", (req) => {
      const failure = req.failure();
      warn(requestId, "[requestfailed]", req.url(), failure?.errorText);
    });

    page.on("response", (resp) => {
      const url = resp.url();
      if (url.includes("busca.inpi.gov.br")) {
        log(requestId, "[response]", resp.status(), url);
      }
    });

    page.on("pageerror", (e) => {
      errlog(requestId, "[pageerror]", e?.message || e);
    });

    const waitOpts = { waitUntil: "domcontentloaded", timeout: 45000 };

    // 1) home
    log(requestId, "[INPI] Step 1 – Home");
    await gotoWithRetry(page, "https://busca.inpi.gov.br/pePI/", requestId, waitOpts, 4);
    await humanPause(page, requestId, "after home");

    // 2) login anônimo
    log(requestId, "[INPI] Step 2 – Login anon");
    await gotoWithRetry(
      page,
      "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login",
      requestId,
      waitOpts,
      4
    );
    await humanPause(page, requestId, "after login");

    // 3) tela de pesquisa (classe básica)
    log(requestId, "[INPI] Step 3 – Pesquisa_classe_basica");
    await gotoWithRetry(
      page,
      "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp",
      requestId,
      waitOpts,
      4
    );
    await humanPause(page, requestId, "before typing");

    // 4) preencher marca
    log(requestId, `[INPI] Step 4 – Fill form (marca=${marca})`);
    await page.waitForSelector('input[name="marca"]', { timeout: 25000 });

    // limpa e digita devagar
    await page.click('input[name="marca"]', { clickCount: 3 });
    await humanPause(page, requestId, "before type");
    await page.type('input[name="marca"]', marca, { delay: 45 });

    await humanPause(page, requestId, "before submit");

    // 5) submit
    log(requestId, "[INPI] Step 5 – Submit");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }),
      page.click('input[name="botao"]'),
    ]);

    await humanPause(page, requestId, "after submit");

    const html = await page.content();

    const looksOk =
      html.includes("RESULTADO DA PESQUISA") ||
      /Foram encontrados?\s*\d+\s*processos?/i.test(html) ||
      html.toLowerCase().includes("nenhum resultado") ||
      html.toLowerCase().includes("processos que satisfazem");

    log(requestId, "[INPI] HTML length:", html.length, "looksOk:", looksOk);

    if (!looksOk) {
      warn(requestId, "[INPI] HTML não parece resultado. Snippet:", html.slice(0, 900));
    }

    return html;
  } finally {
    log(requestId, "[INPI] Closing browser...");
    await browser.close().catch(() => {});
  }
}

// -------------------------
// API
app.post("/consulta-inpi", async (req, res) => {
  const requestId = rid();

  try {
    const marca = String(req.body?.marca || "").trim();
    log(requestId, "[API] Consulta marca:", marca);

    if (!marca || marca.length < 2) {
      return res.status(400).json({ ok: false, error: "Invalid 'marca'" });
    }

    const html = await fetchInpiHtmlByMarca(marca, requestId);

    return res.status(200).json({ ok: true, marca, html });
  } catch (e) {
    errlog(requestId, "[API ERROR]", e?.stack || e?.message || e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
    });
  }
});

// -------------------------
// Start + graceful shutdown (evita sujeira de SIGTERM)
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`INPI API running on port ${PORT}`);
});

function shutdown(signal) {
  console.log(`[${now()}] Received ${signal}. Shutting down...`);
  server.close(() => {
    console.log(`[${now()}] HTTP server closed.`);
    process.exit(0);
  });

  // hard-exit se travar
  setTimeout(() => {
    console.log(`[${now()}] Force exit.`);
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
