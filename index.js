import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_PROJECT_URL =
  process.env.SUPABASE_PROJECT_URL ||
  "https://mqnvfjteuwqbomvbmyhd.supabase.co";

const app = express();
app.use(express.json({ limit: "200kb" }));

/* ----------------- LOG HELPERS ----------------- */
const now = () => new Date().toISOString();
const rid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const log = (id, ...a) => console.log(`[${now()}][${id}]`, ...a);
const warn = (id, ...a) => console.warn(`[${now()}][${id}]`, ...a);
const error = (id, ...a) => console.error(`[${now()}][${id}]`, ...a);

/* ----------------- CORS ----------------- */
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (origin === SUPABASE_PROJECT_URL) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Internal-Token"],
  })
);

/* ----------------- HEALTH ----------------- */
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

/* ----------------- AUTH GATE ----------------- */
app.use((req, res, next) => {
  if (req.method === "GET") return next();

  const token = req.header("X-Internal-Token");
  const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

  if (!INTERNAL_API_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_API_TOKEN not configured",
    });
  }

  if (token !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
});

/* ----------------- INPI SCRAPER ----------------- */
async function fetchInpiHtmlByMarca(marca, requestId) {
  log(requestId, "Launching Puppeteer");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
    );

    const goto = async (url) => {
      log(requestId, "goto:", url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    };

    await goto("https://busca.inpi.gov.br/pePI/");
    await goto(
      "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login"
    );
    await goto(
      "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp"
    );

    await page.waitForSelector('input[name="marca"]', { timeout: 20000 });
    await page.click('input[name="marca"]', { clickCount: 3 });
    await page.type('input[name="marca"]', marca, { delay: 20 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
      page.click('input[name="botao"]'),
    ]);

    const html = await page.content();
    log(requestId, "HTML length:", html.length);

    return html;
  } finally {
    log(requestId, "Closing browser");
    await browser.close();
  }
}

/* ----------------- API ----------------- */
app.post("/consulta-inpi", async (req, res) => {
  const requestId = rid();

  try {
    const marca = String(req.body?.marca || "").trim();
    log(requestId, "Consulta:", marca);

    if (marca.length < 2) {
      return res.status(400).json({ ok: false, error: "Invalid marca" });
    }

    const html = await fetchInpiHtmlByMarca(marca, requestId);

    res.json({ ok: true, marca, html });
  } catch (e) {
    error(requestId, e);
    res.status(500).json({
      ok: false,
      error: e?.message || "INPI fetch failed",
    });
  }
});

/* ----------------- START ----------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`INPI API running on port ${PORT}`);
});
