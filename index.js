import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const PORT = Number(process.env.PORT || 10000);
const SUPABASE_PROJECT_URL =
  process.env.SUPABASE_PROJECT_URL ||
  "https://mqnvfjteuwqbomvbmyhd.supabase.co";

const app = express();
app.use(express.json({ limit: "200kb" }));

/* ======================================================
   LOG HELPERS
====================================================== */
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
function err(id, ...args) {
  console.error(`[${now()}] [${id}]`, ...args);
}

/* ======================================================
   CORS (defensivo)
====================================================== */
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (origin === SUPABASE_PROJECT_URL) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Internal-Token"],
  })
);

/* ======================================================
   HEALTH (Render depende disso)
====================================================== */
app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));

/* ======================================================
   AUTH GATE (NÃO MATA O PROCESSO)
====================================================== */
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "OPTIONS") return next();

  const token = req.header("X-Internal-Token");
  const expected = process.env.INTERNAL_API_TOKEN;

  if (!expected) {
    console.error("⚠️ INTERNAL_API_TOKEN not set");
    return res.status(500).json({ ok: false, error: "Server misconfigured" });
  }

  if (token !== expected) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
});

/* ======================================================
   PUPPETEER FLOW (COM LOGS)
====================================================== */
async function fetchInpiHtmlByMarca(marca, requestId) {
  log(requestId, "Launching Puppeteer");

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

    await page.setCacheEnabled(false);
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"
    );

    page.on("requestfailed", (r) =>
      warn(requestId, "REQ FAIL", r.url(), r.failure()?.errorText)
    );
    page.on("pageerror", (e) =>
      err(requestId, "PAGE ERROR", e.message)
    );
    page.on("response", (r) => {
      if (r.url().includes("inpi")) {
        log(requestId, "RESP", r.status(), r.url());
      }
    });

    const nav = { waitUntil: "domcontentloaded", timeout: 35000 };

    log(requestId, "STEP 1 home");
    await page.goto("https://busca.inpi.gov.br/pePI/", nav);

    log(requestId, "STEP 2 login anon");
    await page.goto(
      "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login",
      nav
    );

    log(requestId, "STEP 3 search page");
    await page.goto(
      "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp",
      nav
    );

    log(requestId, "STEP 4 fill form");
    await page.waitForSelector('input[name="marca"]', { timeout: 20000 });
    await page.click('input[name="marca"]', { clickCount: 3 });
    await page.type('input[name="marca"]', marca, { delay: 10 });

    log(requestId, "STEP 5 submit");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 35000 }),
      page.click('input[name="botao"]'),
    ]);

    const html = await page.content();
    log(requestId, "HTML size", html.length);

    return html;
  } finally {
    log(requestId, "Closing browser");
    await browser.close();
  }
}

/* ======================================================
   API
====================================================== */
app.post("/consulta-inpi", async (req, res) => {
  const requestId = rid();

  try {
    const marca = String(req.body?.marca || "").trim();
    log(requestId, "consulta-inpi", marca);

    if (!marca || marca.length < 2) {
      return res.status(400).json({ ok: false, error: "Invalid marca" });
    }

    const html = await fetchInpiHtmlByMarca(marca, requestId);

    return res.json({ ok: true, marca, html });
  } catch (e) {
    err(requestId, "HANDLER ERROR", e?.stack || e?.message || e);
    return res.status(500).json({ ok: false, error: "INPI fetch failed" });
  }
});

/* ======================================================
   START (NUNCA MORRE)
====================================================== */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ INPI API running on port ${PORT}`);
});
