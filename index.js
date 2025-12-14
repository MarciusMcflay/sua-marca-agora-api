import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

/**
 * =========================
 * CONFIG BÁSICA (NÃO CRASHA)
 * =========================
 */
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "__MISSING__";
const SUPABASE_PROJECT_URL =
  process.env.SUPABASE_PROJECT_URL ||
  "https://mqnvfjteuwqbomvbmyhd.supabase.co";

const PORT = Number(process.env.PORT || 10000);

const app = express();
app.use(express.json({ limit: "200kb" }));

/**
 * =========================
 * LOG HELPERS
 * =========================
 */
function ts() {
  return new Date().toISOString();
}
function rid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function log(id, ...args) {
  console.log(`[${ts()}] [${id}]`, ...args);
}
function warn(id, ...args) {
  console.warn(`[${ts()}] [${id}]`, ...args);
}
function error(id, ...args) {
  console.error(`[${ts()}] [${id}]`, ...args);
}

/**
 * =========================
 * CORS (DEFENSIVO)
 * =========================
 */
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server
      if (origin === SUPABASE_PROJECT_URL) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Internal-Token"],
  })
);

/**
 * =========================
 * HEALTH (RENDER PRECISA)
 * =========================
 */
app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));

/**
 * =========================
 * TOKEN GATE (NÃO CRASHA)
 * =========================
 */
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "OPTIONS") return next();

  if (INTERNAL_API_TOKEN === "__MISSING__") {
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_API_TOKEN not configured",
    });
  }

  const token = req.header("X-Internal-Token");
  if (token !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
});

/**
 * =========================
 * PUPPETEER – CORE
 * =========================
 */
async function withRetries(fn, retries, delayMs, requestId) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      log(requestId, `Attempt ${i}/${retries}`);
      return await fn();
    } catch (e) {
      lastErr = e;
      warn(requestId, `Attempt ${i} failed:`, e.message);
      if (i < retries) {
        await new Promise((r) => setTimeout(r, delayMs * i));
      }
    }
  }
  throw lastErr;
}

async function fetchInpiHtmlByMarca(marca, requestId) {
  return withRetries(
    async () => {
      log(requestId, "[INPI] Launching browser");

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

        await page.setUserAgent(
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"
        );

        page.on("requestfailed", (req) => {
          warn(requestId, "[requestfailed]", req.url(), req.failure()?.errorText);
        });

        log(requestId, "[INPI] Step 1 – Home");
        await page.goto("https://busca.inpi.gov.br/pePI/", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        log(requestId, "[INPI] Step 2 – Login anon");
        await page.goto(
          "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login",
          { waitUntil: "domcontentloaded", timeout: 30000 }
        );

        log(requestId, "[INPI] Step 3 – Busca simples");
        await page.goto(
          "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp",
          { waitUntil: "domcontentloaded", timeout: 30000 }
        );

        log(requestId, "[INPI] Step 4 – Submit");
        await page.waitForSelector('input[name="marca"]', { timeout: 20000 });
        await page.click('input[name="marca"]', { clickCount: 3 });
        await page.type('input[name="marca"]', marca, { delay: 15 });

        await Promise.all([
          page.waitForNavigation({
            waitUntil: "domcontentloaded",
            timeout: 35000,
          }),
          page.click('input[name="botao"]'),
        ]);

        const html = await page.content();
        log(requestId, "[INPI] HTML length:", html.length);

        return html;
      } finally {
        log(requestId, "[INPI] Closing browser");
        await browser.close();
      }
    },
    3, // retries
    1500, // backoff base
    requestId
  );
}

/**
 * =========================
 * API
 * =========================
 */
app.post("/consulta-inpi", async (req, res) => {
  const requestId = rid();

  try {
    const marca = String(req.body?.marca || "").trim();
    log(requestId, "[API] Consulta marca:", marca);

    if (!marca || marca.length < 2) {
      return res.status(400).json({ ok: false, error: "Invalid marca" });
    }

    const html = await fetchInpiHtmlByMarca(marca, requestId);

    return res.status(200).json({
      ok: true,
      marca,
      html,
    });
  } catch (e) {
    error(requestId, "[API ERROR]", e.message);
    return res.status(503).json({
      ok: false,
      error: "INPI temporarily unavailable",
      detail: e.message,
    });
  }
});

/**
 * =========================
 * START (SEM DUPLO PROCESSO)
 * =========================
 */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`INPI API running on port ${PORT}`);
});
