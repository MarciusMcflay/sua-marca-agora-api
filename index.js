import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

/* =========================
   ENV (NUNCA dar throw aqui)
========================= */
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";
const SUPABASE_PROJECT_URL =
  process.env.SUPABASE_PROJECT_URL ||
  "https://mqnvfjteuwqbomvbmyhd.supabase.co";

const PORT = Number(process.env.PORT || 3000);

/* =========================
   APP
========================= */
const app = express();
app.use(express.json({ limit: "200kb" }));

/* =========================
   CORS (defensivo)
========================= */
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

/* =========================
   HEALTH (Render precisa)
========================= */
app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));

/* =========================
   AUTH GATE
========================= */
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "OPTIONS") return next();

  if (!INTERNAL_API_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_API_TOKEN not configured",
    });
  }

  if (req.header("X-Internal-Token") !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
});

/* =========================
   PUPPETEER CORE
========================= */
async function fetchInpiHtmlByMarca(marca) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"
    );

    await page.goto("https://busca.inpi.gov.br/pePI/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.goto(
      "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login",
      {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }
    );

    await page.goto(
      "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp",
      {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }
    );

    await page.waitForSelector('input[name="marca"]', { timeout: 20000 });
    await page.click('input[name="marca"]', { clickCount: 3 });
    await page.type('input[name="marca"]', marca);

    await Promise.all([
      page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }),
      page.click('input[name="botao"]'),
    ]);

    return await page.content();
  } finally {
    await browser.close();
  }
}

/* =========================
   ROUTE
========================= */
app.post("/consulta-inpi", async (req, res) => {
  try {
    const marca = String(req.body?.marca || "").trim();
    if (marca.length < 2) {
      return res.status(400).json({ ok: false, error: "Invalid marca" });
    }

    const html = await fetchInpiHtmlByMarca(marca);

    return res.json({
      ok: true,
      marca,
      html,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "INPI fetch failed",
    });
  }
});

/* =========================
   START + SIGTERM SAFE
========================= */
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`INPI API running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  server.close(() => process.exit(0));
});
