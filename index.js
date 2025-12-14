import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) throw new Error("Missing INTERNAL_API_TOKEN env var");

const SUPABASE_PROJECT_URL =
  process.env.SUPABASE_PROJECT_URL || "https://mqnvfjteuwqbomvbmyhd.supabase.co";

const PORT = Number(process.env.PORT || 10000);

const app = express();
app.use(express.json({ limit: "200kb" }));

// -------- Logging helpers
function now() {
  return new Date().toISOString();
}
function rid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function log(requestId, ...args) {
  console.log(`[${now()}] [${requestId}]`, ...args);
}
function warn(requestId, ...args) {
  console.warn(`[${now()}] [${requestId}]`, ...args);
}
function err(requestId, ...args) {
  console.error(`[${now()}] [${requestId}]`, ...args);
}

// -------- CORS defensivo (não é segurança real)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server
      if (SUPABASE_PROJECT_URL && origin === SUPABASE_PROJECT_URL) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "OPTIONS", "GET"],
    allowedHeaders: ["Content-Type", "X-Internal-Token"],
    maxAge: 86400,
  })
);

// Health endpoints (sem token)
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Token gate (somente POST/PUT/etc)
app.use((req, res, next) => {
  if (req.method === "GET") return next();
  if (req.method === "OPTIONS") return res.sendStatus(204);

  const token = req.header("X-Internal-Token");
  if (token !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

// -------- Puppeteer helpers
async function gotoWithRetry(page, url, requestId, opts, retries = 3) {
  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log(requestId, `goto attempt ${attempt}/${retries}:`, url);
      const resp = await page.goto(url, opts);
      const status = resp?.status?.() ?? "no-response";
      log(requestId, `goto OK: ${url} status=${status} finalUrl=${page.url()}`);
      return resp;
    } catch (e) {
      lastErr = e;
      warn(requestId, `goto FAIL attempt ${attempt}: ${url}`, e?.message || e);
      // backoff simples
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }

  throw lastErr;
}

async function fetchInpiHtmlByMarca(marca, requestId) {
  log(requestId, "Launching browser...");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
    ],
  });

  try {
    const page = await browser.newPage();

    // Dica: estabiliza alguns bloqueios
    await page.setCacheEnabled(false);
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"
    );

    const ua = await page.evaluate(() => navigator.userAgent).catch(() => null);
    log(requestId, "User-Agent (page):", ua);

    // ---- Eventos de debug
    page.on("console", (msg) => {
      log(requestId, `[browser console] ${msg.type()}: ${msg.text()}`);
    });

    page.on("pageerror", (e) => {
      err(requestId, "[pageerror]", e?.message || e);
    });

    page.on("requestfailed", (req) => {
      const failure = req.failure();
      warn(requestId, "[requestfailed]", req.url(), failure?.errorText);
    });

    page.on("response", async (resp) => {
      const url = resp.url();
      if (url.includes("busca.inpi.gov.br")) {
        log(requestId, "[response]", resp.status(), url);
      }
    });

    const waitOpts = { waitUntil: "domcontentloaded", timeout: 35000 };

    // 1) home
    await gotoWithRetry(page, "https://busca.inpi.gov.br/pePI/", requestId, waitOpts, 4);

    // 2) login anon
    await gotoWithRetry(
      page,
      "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login",
      requestId,
      waitOpts,
      3
    );

    // 3) tela de busca simples
    await gotoWithRetry(
      page,
      "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp",
      requestId,
      waitOpts,
      3
    );

    // 4) preencher e submeter
    log(requestId, "Waiting input[name=marca]...");
    await page.waitForSelector('input[name="marca"]', { timeout: 20000 });

    log(requestId, "Typing marca:", marca);
    await page.click('input[name="marca"]', { clickCount: 3 });
    await page.type('input[name="marca"]', marca, { delay: 10 });

    log(requestId, "Submitting form (click botao) and waiting navigation...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 35000 }),
      page.click('input[name="botao"]'),
    ]);

    const html = await page.content();

    // sanity check
    const looksOk =
      html.includes("RESULTADO DA PESQUISA") ||
      /Foram encontrados?\s*\d+\s*processos?/i.test(html) ||
      html.toLowerCase().includes("nenhum resultado");

    log(requestId, "HTML length:", html.length, "looksOk:", looksOk);

    if (!looksOk) {
      warn(requestId, "HTML does not look like result page. Snippet:", html.slice(0, 800));
    }

    return html;
  } finally {
    log(requestId, "Closing browser...");
    await browser.close();
  }
}

// -------- API
app.post("/consulta-inpi", async (req, res) => {
  const requestId = rid();

  try {
    const marca = String(req.body?.marca || "").trim();
    log(requestId, "POST /consulta-inpi marca=", marca);

    if (!marca || marca.length < 2) {
      return res.status(400).json({ ok: false, error: "Invalid 'marca'" });
    }

    const html = await fetchInpiHtmlByMarca(marca, requestId);

    return res.status(200).json({
      ok: true,
      marca,
      html,
    });
  } catch (e) {
    err(requestId, "Handler error:", e?.stack || e?.message || e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`INPI API running on port ${PORT}`);
});
