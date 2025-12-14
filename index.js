import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json({ limit: "200kb" }));

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) throw new Error("Missing INTERNAL_API_TOKEN");

const SUPABASE_PROJECT_URL = process.env.SUPABASE_PROJECT_URL || "https://mqnvfjteuwqbomvbmyhd.supabase.co";
const PORT = process.env.PORT || 3000;

// CORS defensivo (não é a segurança real)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server
      if (SUPABASE_PROJECT_URL && origin === SUPABASE_PROJECT_URL) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Internal-Token"],
    maxAge: 86400
  })
);

app.options("*", (_, res) => res.sendStatus(204));

// Segurança REAL: token
app.use((req, res, next) => {
  const token = req.header("X-Internal-Token");
  if (token !== INTERNAL_API_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.post("/consulta-inpi", async (req, res) => {
  const marca = String(req.body?.marca || "").trim();
  if (!marca || marca.length < 2) return res.status(400).json({ error: "Invalid 'marca'" });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45000);

    // 1) site principal
    await page.goto("https://busca.inpi.gov.br/pePI/", { waitUntil: "domcontentloaded" });

    // 2) login anônimo
    await page.goto("https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login", {
      waitUntil: "domcontentloaded"
    });

    // 3) busca simples por marca
    await page.goto("https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp", {
      waitUntil: "domcontentloaded"
    });

    // 4) preenche e submete
    await page.waitForSelector('input[name="marca"]', { timeout: 20000 });
    await page.evaluate(() => {
      const el = document.querySelector('input[name="marca"]');
      if (el) el.value = "";
    });
    await page.type('input[name="marca"]', marca, { delay: 10 });

    // clique e espera navegação (resultados)
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('input[name="botao"]')
    ]);

    const html = await page.content();

    return res.json({ ok: true, marca, html });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => console.log(`INPI puppeteer proxy listening on :${PORT}`));
