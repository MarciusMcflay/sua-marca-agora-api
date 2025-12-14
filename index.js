import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) {
  // Se isso aparecer, é 99% env var não aplicada no serviço, ou deploy não reiniciado.
  console.error("Missing INTERNAL_API_TOKEN env var");
  process.exit(1);
}

const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.json({ limit: "200kb" }));

// CORS defensivo (não é a segurança principal; o token é)
app.use(
  cors({
    origin: (origin, cb) => {
      // Edge Function (server-to-server) normalmente vem sem Origin
      if (!origin) return cb(null, true);
      return cb(null, false); // bloqueia browser por padrão
    },
    methods: ["POST", "OPTIONS", "GET"],
    allowedHeaders: ["Content-Type", "X-Internal-Token"],
    maxAge: 86400
  })
);

app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Middleware de auth real
app.use((req, res, next) => {
  const token = req.header("X-Internal-Token");
  if (token !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

// POST /consulta-inpi { marca: "shinier" }
app.post("/consulta-inpi", async (req, res) => {
  const marca = String(req.body?.marca || "").trim();
  if (!marca || marca.length < 2) {
    return res.status(400).json({ ok: false, error: "Invalid 'marca'" });
  }

  let browser;
  try {
    // Importante: flags pro ambiente container
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);

    // 1) home
    await page.goto("https://busca.inpi.gov.br/pePI/", { waitUntil: "domcontentloaded" });

    // 2) login anônimo
    await page.goto(
      "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login",
      { waitUntil: "domcontentloaded" }
    );

    // 3) tela de busca por marca (classe básica)
    await page.goto(
      "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp",
      { waitUntil: "domcontentloaded" }
    );

    // 4) preencher e enviar
    await page.waitForSelector('input[name="marca"]', { timeout: 15000 });
    await page.evaluate(() => {
      const el = document.querySelector('input[name="marca"]');
      if (el) el.value = "";
    });
    await page.type('input[name="marca"]', marca, { delay: 10 });

    // clicar e esperar navegação
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('input[name="botao"]')
    ]);

    const html = await page.content();

    return res.status(200).json({
      ok: true,
      marca,
      html
    });
  } catch (err) {
    console.error("consulta-inpi error:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Unknown error"
    });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`INPI API running on port ${PORT}`);
});
